// Live SMTP mailbox probe.
//
// Opens a raw TCP connection to the domain's highest-priority MX host on port
// 25 and runs the SMTP conversation up to RCPT TO: — then issues QUIT. It NEVER
// sends DATA, so NO email is ever delivered. The server's reply code to RCPT TO
// tells us whether the mailbox exists:
//   250 / 251        -> mailbox accepted (likely deliverable)
//   550 / 551 / 553  -> mailbox rejected (does not exist)
//   552 / 450 / 451  -> temporary / quota -> inconclusive
//   greylisting (4xx)-> inconclusive
//
// Many networks (Vercel's serverless egress included) block outbound port 25.
// When that happens the probe returns { ok:false, reason:"port25_blocked" } and
// the engine HONESTLY degrades to MX + syntax + disposable + role signals,
// stating in the output that the live SMTP probe could not run. We never invent
// a mailbox-exists result.

import net from "node:net";

export type SmtpProbeStatus =
  | "deliverable" // RCPT accepted
  | "undeliverable" // RCPT rejected -> mailbox does not exist
  | "catch_all" // server accepts everything (random probe also accepted)
  | "greylisted" // 4xx temporary
  | "unknown" // inconclusive
  | "blocked"; // could not connect / port 25 egress blocked

export interface SmtpProbeResult {
  status: SmtpProbeStatus;
  mxHost: string | null;
  code: number | null;
  message: string | null;
  catchAll: boolean | null; // null = not tested
  durationMs: number;
}

const HELO_DOMAIN = process.env.SMTP_HELO_DOMAIN || "verify.local";
const MAIL_FROM = process.env.SMTP_MAIL_FROM || "verify@verify.local";
const CONNECT_TIMEOUT_MS = Number(process.env.SMTP_CONNECT_TIMEOUT_MS || 7000);
const STEP_TIMEOUT_MS = Number(process.env.SMTP_STEP_TIMEOUT_MS || 7000);

interface SmtpReply {
  code: number;
  text: string;
}

// Run one SMTP RCPT conversation on a given MX host for one or more recipients.
// Returns the reply code for each recipient probed (in order), or throws/usable
// status on connection failure.
async function smtpConversation(
  mxHost: string,
  recipients: string[]
): Promise<{ connected: boolean; replies: (SmtpReply | null)[]; banner?: SmtpReply }>
{
  return new Promise((resolve) => {
    const replies: (SmtpReply | null)[] = [];
    let banner: SmtpReply | undefined;
    let buffer = "";
    let stage = 0; // 0 banner, 1 EHLO, 2 MAIL FROM, then one per recipient, then QUIT
    let rcptIndex = 0;
    let settled = false;
    const socket = new net.Socket();

    const finish = (connected: boolean) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* noop */ }
      resolve({ connected, replies, banner });
    };

    socket.setTimeout(CONNECT_TIMEOUT_MS);

    const write = (line: string) => {
      try { socket.write(line + "\r\n"); } catch { finish(true); }
    };

    const parseReply = (chunk: string): SmtpReply | null => {
      // SMTP multiline: "250-foo\r\n250 bar\r\n". The final line has a space
      // after the code. Return once we have a complete reply.
      const lines = chunk.split(/\r?\n/).filter(Boolean);
      if (!lines.length) return null;
      const last = lines[lines.length - 1];
      const m = last.match(/^(\d{3})(?:[ -])?(.*)$/);
      if (!m) return null;
      // ensure the last line uses space (final), not dash (continuation)
      if (/^\d{3}-/.test(last)) return null;
      return { code: Number(m[1]), text: lines.join(" ") };
    };

    socket.on("data", (data) => {
      buffer += data.toString("utf8");
      // Only act once we have a complete (final) reply line.
      const reply = parseReply(buffer);
      if (!reply) return;
      buffer = "";
      socket.setTimeout(STEP_TIMEOUT_MS);

      if (stage === 0) {
        banner = reply;
        if (reply.code >= 400) return finish(true); // server not ready
        stage = 1;
        write(`EHLO ${HELO_DOMAIN}`);
      } else if (stage === 1) {
        // some servers reject EHLO; fall back to HELO once
        if (reply.code >= 400 && reply.code !== 250) {
          write(`HELO ${HELO_DOMAIN}`);
          stage = 1.5 as unknown as number;
          return;
        }
        stage = 2;
        write(`MAIL FROM:<${MAIL_FROM}>`);
      } else if ((stage as number) === 1.5) {
        stage = 2;
        write(`MAIL FROM:<${MAIL_FROM}>`);
      } else if (stage === 2) {
        if (reply.code >= 400) return finish(true); // can't even set sender
        stage = 3;
        write(`RCPT TO:<${recipients[rcptIndex]}>`);
      } else if (stage === 3) {
        replies[rcptIndex] = reply;
        rcptIndex++;
        if (rcptIndex < recipients.length) {
          write(`RCPT TO:<${recipients[rcptIndex]}>`);
        } else {
          write("QUIT");
          finish(true);
        }
      }
    });

    socket.on("timeout", () => finish(replies.length > 0 || stage > 0));
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(stage > 0));

    socket.connect(25, mxHost);
  });
}

// Probe whether `email` is deliverable. Also probes a guaranteed-nonexistent
// random address on the same server to detect catch-all (a server that accepts
// everything, making the real-mailbox answer meaningless).
export async function probeMailbox(
  email: string,
  mxHosts: string[]
): Promise<SmtpProbeResult> {
  const started = Date.now();
  if (!mxHosts.length) {
    return { status: "blocked", mxHost: null, code: null, message: "no MX hosts", catchAll: null, durationMs: 0 };
  }

  const domain = email.split("@")[1];
  const randomLocal = `nonexistent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const randomAddr = `${randomLocal}@${domain}`;

  // Try MX hosts in priority order until one connects.
  for (const mx of mxHosts) {
    const conv = await smtpConversation(mx, [email, randomAddr]);
    if (!conv.connected) continue; // try next MX

    const realReply = conv.replies[0];
    const randReply = conv.replies[1];

    if (!realReply) {
      // connected but no usable RCPT reply (server closed early / greylist)
      return { status: "unknown", mxHost: mx, code: null, message: "no RCPT reply", catchAll: null, durationMs: Date.now() - started };
    }

    const accepts = (r: SmtpReply | null | undefined) => !!r && (r.code === 250 || r.code === 251);
    const rejects = (r: SmtpReply | null | undefined) => !!r && (r.code === 550 || r.code === 551 || r.code === 553 || r.code === 554);
    const greylist = (r: SmtpReply | null | undefined) => !!r && r.code >= 450 && r.code < 500;

    const catchAll = accepts(randReply) ? true : rejects(randReply) ? false : null;

    let status: SmtpProbeStatus;
    if (catchAll === true) {
      status = "catch_all"; // can't trust per-mailbox answer
    } else if (accepts(realReply)) {
      status = "deliverable";
    } else if (rejects(realReply)) {
      status = "undeliverable";
    } else if (greylist(realReply)) {
      status = "greylisted";
    } else {
      status = "unknown";
    }

    return {
      status,
      mxHost: mx,
      code: realReply.code,
      message: realReply.text.slice(0, 200),
      catchAll,
      durationMs: Date.now() - started,
    };
  }

  // No MX host accepted a TCP connection on :25 — almost certainly egress
  // blocking (e.g. serverless) or all MX down/firewalled.
  return {
    status: "blocked",
    mxHost: mxHosts[0],
    code: null,
    message: "could not open SMTP :25 (egress likely blocked)",
    catchAll: null,
    durationMs: Date.now() - started,
  };
}
