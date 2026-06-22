// email-verify HTTP server.
//
// Surfaces:
//   GET /verify?email=<addr>            -> FREE tier, IP rate-limited (no SMTP probe).
//   GET /pro/verify?email=<addr>        -> PAID per call via x402 (DEEP: live SMTP RCPT probe).
//   GET /pro/verify_many?emails=a,b,c   -> PAID, batch DEEP.
//   POST /mcp                           -> MCP-over-HTTP (free).
//   GET /health, GET /  (landing/json)  -> free.
//
// The paid routes are gated by x402's paymentMiddleware. Payment settles in
// USDC straight to PAYTO on Base. The server holds NO private key — payTo is a
// public receiving address only.

import express, { Request, Response, NextFunction } from "express";
import { paymentMiddleware, Network } from "x402-express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyEmail } from "./engine.js";
import { buildMcpServer } from "./mcpServer.js";

const PORT = Number(process.env.PORT ?? 8080);

const PAYTO = (process.env.X402_PAYTO ?? "0x074cFCfDf4509333a8d8dC0f90D18Ef276481c21") as `0x${string}`;
const NETWORK = (process.env.X402_NETWORK ?? "base") as Network;
const PRICE = process.env.X402_PRICE ?? "$0.05";
const FACILITATOR_URL = process.env.X402_FACILITATOR_URL; // mainnet settle facilitator (Primer)
const PAYMENTS_ENABLED = process.env.X402_ENABLED !== "false";

const app = express();
app.disable("x-powered-by");

const landing = {
  name: "email-verify",
  description:
    "Live email verification: syntax, MX, disposable/temp detection, role-based, catch-all and a live SMTP mailbox probe (RCPT-TO, no mail sent). Returns VALID / RISKY / INVALID + deliverability score.",
  endpoints: {
    "GET /verify?email=<addr>": "Free (rate-limited: 30/h/IP). Syntax + MX + disposable + role.",
    "GET /pro/verify?email=<addr>": "Pay-per-call USDC via x402 (Base). DEEP: live SMTP mailbox probe.",
    "GET /pro/verify_many?emails=a,b,c": "Pay-per-call USDC via x402 (Base), DEEP, up to 50 addresses.",
    "POST /mcp": "MCP-over-HTTP (free) — use as an MCP server.",
  },
  repo: "https://github.com/Baneado98/email-verify",
};

const LANDING_HTML = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>email-verify — check if an email is real before you send</title><meta name="description" content="Live email verification API + MCP server. Validate syntax, MX records, disposable/temp domains, role-based and catch-all addresses, and probe the real SMTP mailbox (no email sent). VALID / RISKY / INVALID with a deliverability score."><meta name="keywords" content="email verification api, verify email address, check if email exists, email validation mcp server, disposable email detection, smtp mailbox verification, catch-all detection, email deliverability score, clean email list, bounce reduction, x402 pay per call, AI agent email verify"><link rel="canonical" href="https://email-verify-seven.vercel.app/"><meta property="og:type" content="website"><meta property="og:title" content="email-verify — check if an email is real before you send"><meta property="og:description" content="Live email verification: syntax, MX, disposable, role-based, catch-all and a real SMTP mailbox probe. MCP server + pay-per-call x402 API for AI agents."><meta property="og:url" content="https://email-verify-seven.vercel.app/"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="email-verify — check if an email is real"><meta name="twitter:description" content="Live email verification API + MCP server. Syntax, MX, disposable, role, catch-all, live SMTP mailbox probe."><script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"email-verify","applicationCategory":"DeveloperApplication","operatingSystem":"Any","description":"Live email verification as an MCP server and pay-per-call x402 API. Checks syntax, live MX records, disposable/temporary domains, role-based and catch-all addresses, and probes the real SMTP mailbox without sending mail.","offers":{"@type":"Offer","price":"0.05","priceCurrency":"USD","description":"Pay-per-call via x402 (USDC on Base); free MCP and HTTP tiers"},"url":"https://email-verify-seven.vercel.app/","softwareHelp":"https://github.com/Baneado98/email-verify"}</script><script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How do I check if an email address is real before sending?","acceptedAnswer":{"@type":"Answer","text":"Run email-verify: npx -y mailbox-verify-mcp as an MCP server, or GET https://email-verify-seven.vercel.app/verify?email=ADDRESS. It returns a VALID / RISKY / INVALID verdict by checking syntax, the domain's live MX records, disposable/temp-mail domains, role-based mailboxes, catch-all, and (paid tier) a live SMTP RCPT-TO probe that confirms the mailbox exists without sending any email."}},{"@type":"Question","name":"How can I detect disposable or temporary email addresses?","acceptedAnswer":{"@type":"Answer","text":"email-verify ships an embedded catalog of disposable / temp-mail providers (Mailinator, 10minutemail, temp-mail, Guerrilla Mail and hundreds more) and flags any address on one of them as RISKY in a single call."}},{"@type":"Question","name":"Can I verify an email without sending a message to it?","acceptedAnswer":{"@type":"Answer","text":"Yes. email-verify opens an SMTP conversation to the domain's real mail server up to RCPT TO: and then quits — it never sends DATA, so no email is ever delivered, while the server's reply tells you whether the mailbox exists."}}]}</script><style>:root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;font-family:ui-monospace,Menlo,monospace;background:#0b0e14;color:#d7dce5;line-height:1.6}.wrap{max-width:760px;margin:0 auto;padding:48px 20px 80px}h1{font-size:2.2rem;margin:0 0 4px;color:#fff}.tag{color:#7c8597;margin-bottom:28px}.badge{display:inline-block;background:#16202e;border:1px solid #243044;border-radius:999px;padding:3px 12px;font-size:.8rem;color:#8bd5a0;margin:0 6px 8px 0}h2{font-size:1.05rem;color:#fff;margin:34px 0 10px}code{background:#11161f;border:1px solid #1e2733;border-radius:6px;padding:2px 6px;font-size:.86rem;color:#e2b76a}pre{background:#11161f;border:1px solid #1e2733;border-radius:8px;padding:14px 16px;overflow:auto;font-size:.82rem;color:#cbd3df}a{color:#6aa8ff}table{width:100%;border-collapse:collapse;font-size:.86rem}td{padding:7px 8px;border-bottom:1px solid #1a212c;vertical-align:top}td:first-child{color:#8bd5a0;white-space:nowrap}.d{color:#ff6b6b}.w{color:#e2b76a}.o{color:#8bd5a0}footer{margin-top:40px;color:#5b6472;font-size:.8rem}</style></head><body><div class="wrap"><h1>email-verify ✉️</h1><div class="tag">Find out if an email address is real and deliverable <strong>before</strong> you send.</div><span class="badge">MCP server</span><span class="badge">x402 pay-per-call</span><span class="badge">read-only</span><span class="badge">USDC · Base</span><span class="badge">live SMTP probe</span><span class="badge">disposable catalog</span><p>Give it an address, get a <span class="o">VALID</span> / <span class="w">RISKY</span> / <span class="d">INVALID</span> verdict with a deliverability score — combining live MX/SMTP checks with disposable, role-based and catch-all detection that plain regex validators miss.</p><h2>What it checks</h2><table><tr><td>✉️ Syntax</td><td>RFC-shaped local@domain, length limits, and typos like <code>gmial.com</code> / <code>hotmial.com</code></td></tr><tr><td>📮 MX (live)</td><td>does the domain have mail servers — i.e. can it receive mail at all (live DNS)</td></tr><tr><td>🗑️ Disposable</td><td>hundreds of temp-mail / throwaway providers (<code>mailinator.com</code>, <code>10minutemail</code>, <code>temp-mail</code>, Guerrilla Mail …)</td></tr><tr><td>👥 Role-based</td><td>shared mailboxes (<code>info@</code>, <code>admin@</code>, <code>support@</code>) that hurt deliverability</td></tr><tr><td>🎯 SMTP mailbox</td><td><strong>deep:</strong> live RCPT-TO probe of the real mail server — does the specific inbox exist? No email is ever sent. Plus catch-all detection.</td></tr></table><h2>Free HTTP API</h2><pre>GET /verify?email=jane@example.com
GET /verify?email=foo@mailinator.com   # → RISKY, disposable
GET /verify?email=jane@gmial.com       # → RISKY, domain typo</pre><p>Try it: <a href="/verify?email=jane@example.com">/verify?email=jane@example.com</a> · <a href="/verify?email=foo@mailinator.com">/verify?email=foo@mailinator.com</a></p><h2>MCP server (free)</h2><pre>{
  "mcpServers": {
    "email-verify": { "command": "npx", "args": ["-y", "mailbox-verify-mcp"] }
  }
}</pre><p>Or connect over HTTP at <code>POST /mcp</code>. Tools: <code>verify_email</code>, <code>verify_many</code>.</p><h2>Pay-per-call (x402)</h2><p>The <code>/pro/*</code> routes are gated by <a href="https://x402.org">x402</a>. Your agent pays <strong>$0.05 USDC</strong> per call automatically — no sign-up, no API key. The paid tier runs the live SMTP mailbox probe. Settles on-chain to the operator wallet.</p><pre>GET /pro/verify?email=&lt;addr&gt;        # 402 → pay → deep result
GET /pro/verify_many?emails=...      # up to 50 addresses</pre><footer>Source &amp; docs: <a href="https://github.com/Baneado98/email-verify">github.com/Baneado98/email-verify</a> · MIT</footer></div></body></html>`;

app.get("/", (req, res) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (String(req.headers.accept ?? "").includes("application/json")) return res.json(landing);
  res.type("html").send(LANDING_HTML);
});
app.get(["/api", "/api/", "/index"], (_req, res) => res.json(landing));
app.get("/health", (_req, res) => res.json({ ok: true }));
// 402 Index domain-ownership proof placeholder (replaced after claim).
app.get("/.well-known/402index-verify.txt", (_req, res) =>
  res.type("text/plain").send(process.env.INDEX402_VERIFY_TOKEN ?? "pending"));

// Machine-readable x402 discovery manifest for aggregators / agent crawlers.
app.get("/.well-known/x402-listing", (_req, res) =>
  res.json({
    x402Version: 1,
    name: "email-verify",
    description:
      "Live email verification: syntax, MX, disposable/temp detection, role-based, catch-all and a live SMTP mailbox probe (RCPT-TO, no mail sent). VALID/RISKY/INVALID + deliverability score. For AI agents and list cleaning.",
    category: "developer-tools",
    repository: "https://github.com/Baneado98/email-verify",
    mcp: { npx: "mailbox-verify-mcp", http: "https://email-verify-seven.vercel.app/mcp" },
    endpoints: [
      {
        method: "GET",
        path: "/pro/verify",
        resource: "https://email-verify-seven.vercel.app/pro/verify?email=jane@example.com",
        price: { amount: "0.05", currency: "USD", asset: "USDC", network: "base" },
        payTo: PAYTO,
        scheme: "exact",
        description: "Deep live verification of one email incl. SMTP mailbox probe (pay-per-call).",
      },
      {
        method: "GET",
        path: "/pro/verify_many",
        resource: "https://email-verify-seven.vercel.app/pro/verify_many?emails=jane@example.com,foo@mailinator.com",
        price: { amount: "0.05", currency: "USD", asset: "USDC", network: "base" },
        payTo: PAYTO,
        scheme: "exact",
        description: "Deep verification of up to 50 emails in one call.",
      },
    ],
    free: { verify: "https://email-verify-seven.vercel.app/verify?email=jane@example.com" },
  }));

// ---- MCP-over-HTTP (free) ----------------------------------------------
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err?.message ?? err) }, id: null });
    }
  }
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "Use POST for MCP. GET /verify for the REST API." }));

app.use(express.json({ limit: "256kb" }));

// ---- Free-tier rate limiter (in-memory, per IP) -------------------------
const WINDOW_MS = 60 * 60 * 1000; // 1h
const FREE_LIMIT = 30;
const hits = new Map<string, { count: number; resetAt: number }>();

function rateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = (req.headers["x-forwarded-for"]?.toString().split(",")[0].trim()) || req.ip || "unknown";
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + WINDOW_MS });
    return next();
  }
  rec.count++;
  if (rec.count > FREE_LIMIT) {
    res.setHeader("Retry-After", Math.ceil((rec.resetAt - now) / 1000).toString());
    return res.status(429).json({
      error: "Free-tier rate limit reached.",
      limit: FREE_LIMIT,
      window: "1h",
      hint: `For unlimited use + live SMTP mailbox probe, call /pro/verify (${PRICE} USDC via x402).`,
    });
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
}, WINDOW_MS).unref();

// ---- x402 paid routes ---------------------------------------------------
if (PAYMENTS_ENABLED) {
  const facilitator = FACILITATOR_URL ? { url: FACILITATOR_URL as `${string}://${string}` } : undefined;
  app.use(
    paymentMiddleware(
      PAYTO,
      {
        "GET /pro/verify": {
          price: PRICE,
          network: NETWORK,
          config: { description: "email-verify: deep live verification of a single email incl. SMTP mailbox probe (pay-per-call)." },
        },
        "GET /pro/verify_many": {
          price: PRICE,
          network: NETWORK,
          config: { description: "email-verify: batch deep verification of up to 50 emails (pay-per-call)." },
        },
      },
      facilitator
    )
  );
}

// ---- handlers -----------------------------------------------------------
function handleSingle(deep: boolean) {
  return async (req: Request, res: Response) => {
    const email = String(req.query.email ?? "").trim();
    if (!email) return res.status(400).json({ error: "Query param 'email' is required." });
    try {
      const result = await verifyEmail(email, { deep });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  };
}

function handleMany(cap: number, deep: boolean) {
  return async (req: Request, res: Response) => {
    const raw = String(req.query.emails ?? "").trim();
    if (!raw) return res.status(400).json({ error: "Query param 'emails' (comma-separated) is required." });
    const emails = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, cap);
    try {
      const results = await Promise.all(emails.map((e) => verifyEmail(e, { deep })));
      res.json({ count: results.length, results });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  };
}

// Free — metadata-level (no SMTP probe).
app.get("/verify", rateLimit, handleSingle(false));
app.get("/verify_many", rateLimit, handleMany(10, false));

// Paid (x402-gated) — DEEP: live SMTP RCPT mailbox probe.
app.get("/pro/verify", handleSingle(true));
app.get("/pro/verify_many", handleMany(50, true));

app.use((_req, res) => {
  res.status(404).json({ error: "Not found. See GET / for the endpoint list." });
});
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (!res.headersSent) res.status(500).json({ error: "Internal error", detail: String(err?.message ?? err) });
});

export { app };
export default app;

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}`;
if (isDirectRun || process.env.FORCE_LISTEN === "true") {
  app.listen(PORT, () => {
    console.error(`email-verify HTTP on :${PORT} (payments ${PAYMENTS_ENABLED ? "ON" : "OFF"}, network=${NETWORK}, payTo=${PAYTO})`);
  });
}
