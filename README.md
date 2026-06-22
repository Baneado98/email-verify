# email-verify ✉️

**Find out if an email address is real and deliverable — *before* you send.**

`email-verify` is a live email-verification service shipped two ways:

- an **MCP server** (`npx -y email-verify-mcp`) you plug into Claude, Cursor or any MCP agent, and
- a **pay-per-call HTTP API** gated by [x402](https://x402.org) (USDC on Base) for autonomous agents — no sign-up, no API key.

It returns a **VALID / RISKY / INVALID** verdict with a 0–100 deliverability score and explained reasons.

## What it checks

| Check | What it does |
|---|---|
| ✉️ **Syntax** | RFC-shaped `local@domain`, length limits, and common typos (`gmial.com`, `hotmial.com`, `gmail.con`). |
| 📮 **MX (live)** | Live DNS lookup of the domain's mail servers — can it receive mail at all? Falls back to the A record (implicit MX) per RFC 5321. |
| 🗑️ **Disposable** | Embedded catalog of hundreds of throwaway / temp-mail providers (Mailinator, 10minutemail, temp-mail, Guerrilla Mail, 1secMail …), including wildcard subdomains. |
| 👥 **Role-based** | Shared function mailboxes (`info@`, `admin@`, `support@`, `postmaster@`) that hurt deliverability and don't map to a person. |
| 🌐 **Free provider** | Flags consumer webmail (gmail/outlook/yahoo…) vs a business domain. |
| 🎯 **SMTP mailbox** *(deep)* | Opens a live SMTP conversation to the real mail server up to `RCPT TO:` and quits — **never sends `DATA`, so no email is ever delivered** — to confirm the specific inbox exists. Plus **catch-all** detection (a domain that accepts every address). |

Everything is **read-only**. No email is ever sent.

## Use it as an MCP server (free)

```json
{
  "mcpServers": {
    "email-verify": { "command": "npx", "args": ["-y", "email-verify-mcp"] }
  }
}
```

Tools:

- `verify_email` — verify one address (`deep: true` runs the live SMTP mailbox probe).
- `verify_many` — verify a batch (clean a list before a campaign).

Or connect over HTTP at `POST /mcp`.

## Free HTTP API

```
GET https://email-verify.vercel.app/verify?email=jane@example.com
GET https://email-verify.vercel.app/verify?email=foo@mailinator.com   # → RISKY (disposable)
GET https://email-verify.vercel.app/verify?email=jane@gmial.com       # → RISKY (domain typo)
GET https://email-verify.vercel.app/verify_many?emails=a@x.com,b@y.com
```

Free tier is rate-limited (30 / hour / IP) and runs every check **except** the live SMTP probe.

## Pay-per-call (x402) — the deep tier

The `/pro/*` routes are gated by [x402](https://x402.org). Your agent pays **$0.05 USDC** per call automatically (Base); the paid tier runs the **live SMTP RCPT-TO mailbox probe** and lifts the batch cap to 50.

```
GET /pro/verify?email=<addr>          # 402 → pay → deep result
GET /pro/verify_many?emails=a,b,c     # up to 50 addresses
```

Settlement goes on-chain straight to the operator wallet — the server holds no key.

### A note on honesty about the SMTP probe

Many networks (including serverless egress) block outbound port 25. When the live SMTP probe can't connect, `email-verify` **says so** in the output (`smtp_blocked`) and degrades to MX + syntax + disposable + role signals rather than inventing a mailbox-exists result. The verdict reflects exactly what could and couldn't be confirmed.

## Example output

```json
{
  "email": "jane@example.com",
  "verdict": "VALID",
  "score": 90,
  "deliverable": true,
  "reasons": [
    { "code": "has_mx", "severity": "info", "message": "Domain has 2 MX host(s); top: aspmx.example.com." },
    { "code": "smtp_accept", "severity": "info", "message": "Mailbox accepted by aspmx.example.com (SMTP 250). The inbox exists." }
  ],
  "checks": { "syntaxValid": true, "hasMx": true, "disposable": false, "roleBased": false, "smtp": { "status": "deliverable" } }
}
```

## Why this exists

List cleaning and signup-fraud prevention are things businesses **pay real money** for. An LLM agent can't open a TCP socket to a mail server or carry a maintained disposable-domain catalog on its own — `email-verify` gives it that as one tool call.

## Development

```bash
npm install
npm run dev:http       # local HTTP server on :8080 (payments default ON; set X402_ENABLED=false to disable)
npm run dev:mcp        # local stdio MCP server
npm run test:engine    # deterministic offline tests
```

## License

MIT
