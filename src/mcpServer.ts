// Shared factory that builds the email-verify MCP Server instance and its tool
// handlers. Used by both the stdio entrypoint (mcp.ts) and the HTTP streamable
// transport mounted inside server.ts.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { verifyEmail, type VerifyResult } from "./engine.js";

export function renderText(r: VerifyResult): string {
  const badge =
    r.verdict === "VALID" ? "🟢 VALID"
    : r.verdict === "RISKY" ? "🟠 RISKY"
    : r.verdict === "INVALID" ? "🔴 INVALID"
    : "⚪ UNKNOWN";
  const lines: string[] = [];
  lines.push(`${badge}  —  ${r.email}  (deliverability score ${r.score}/100)`);
  const del = r.deliverable === true ? "yes" : r.deliverable === false ? "no" : "unconfirmed";
  lines.push(`Mailbox deliverable: ${del}`);
  if (r.reasons.length) {
    lines.push("");
    lines.push("Reasons:");
    for (const reason of r.reasons) {
      lines.push(`  • [${reason.severity.toUpperCase()}] ${reason.message}`);
    }
  }
  const c = r.checks;
  lines.push("");
  lines.push(
    `Checks: syntax=${c.syntaxValid} domain=${c.domain ?? "n/a"} hasMX=${c.hasMx} mxHosts=${c.mxHosts.length} disposable=${c.disposable} role=${c.roleBased} free=${c.freeProvider} catchAll=${c.catchAll} smtp=${c.smtp.tested ? c.smtp.status : "not-run"}`
  );
  return lines.join("\n");
}

export function buildMcpServer(): Server {
  const server = new Server(
    { name: "email-verify", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "verify_email",
        description:
          "Verify whether an email address is real and deliverable, live. Checks: syntax (RFC-shaped, typos like gmial.com), the domain's live MX records (can it receive mail at all), whether the domain is a known disposable/temporary provider (Mailinator, temp-mail, 10minutemail, ...), whether the local-part is a role/shared mailbox (info@, admin@, support@), whether it's a consumer free-webmail address, catch-all detection, and — when deep=true — a live SMTP RCPT-TO probe of the real mail server to confirm the specific MAILBOX exists WITHOUT sending any email. Returns a VALID / RISKY / INVALID verdict, a 0-100 deliverability score and explained reasons. Use this before adding an email to a list, accepting a signup, or sending mail you don't want to bounce.",
        inputSchema: {
          type: "object",
          properties: {
            email: { type: "string", description: "The email address to verify, e.g. 'jane@example.com'." },
            deep: { type: "boolean", description: "When true, run the live SMTP RCPT-TO probe to confirm the actual mailbox exists (not just the domain). Slower; degrades gracefully if the host blocks outbound port 25. Recommended for high-stakes verification." },
          },
          required: ["email"],
        },
      },
      {
        name: "verify_many",
        description:
          "Verify a batch of email addresses at once (e.g. a whole mailing list). Returns one verdict per address. Useful to clean a list before a campaign — flagging invalid, disposable, role-based and risky addresses that would bounce or hurt deliverability.",
        inputSchema: {
          type: "object",
          properties: {
            emails: { type: "array", items: { type: "string" }, description: "List of email addresses to verify." },
            deep: { type: "boolean", description: "Run the live SMTP mailbox probe on each (slower)." },
          },
          required: ["emails"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name === "verify_email") {
        const email = String((args as any)?.email ?? "").trim();
        const deep = Boolean((args as any)?.deep);
        if (!email) return { content: [{ type: "text", text: "Error: 'email' is required." }], isError: true };
        const r = await verifyEmail(email, { deep });
        return { content: [{ type: "text", text: renderText(r) }] };
      }
      if (name === "verify_many") {
        const emails: string[] = Array.isArray((args as any)?.emails) ? (args as any).emails.map(String) : [];
        const deep = Boolean((args as any)?.deep);
        if (!emails.length) return { content: [{ type: "text", text: "Error: 'emails' must be a non-empty array." }], isError: true };
        const capped = emails.slice(0, 25);
        const results = await Promise.all(capped.map((e) => verifyEmail(e, { deep })));
        const text = results
          .map((r) => `${r.verdict === "VALID" ? "🟢" : r.verdict === "RISKY" ? "🟠" : r.verdict === "INVALID" ? "🔴" : "⚪"} ${r.email} — ${r.verdict} (${r.score}/100)`)
          .join("\n");
        const note = emails.length > 25 ? `\n\n(Only the first 25 of ${emails.length} addresses were verified on the free tier.)` : "";
        return { content: [{ type: "text", text: text + note }] };
      }
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    } catch (err: any) {
      return { content: [{ type: "text", text: `email-verify error: ${err?.message ?? err}` }], isError: true };
    }
  });

  return server;
}
