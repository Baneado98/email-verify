// email-verify core engine.
//
// Given an email address, runs a layered, READ-ONLY verification:
//   1. Syntax   — RFC-shaped local@domain, length limits, obvious typos.
//   2. Domain   — does it resolve, and does it have MX records (can it receive
//                 mail at all)? Live DNS via node:dns.
//   3. Disposable — is the domain a known throwaway/temp-mail provider?
//   4. Role     — is the local-part a shared role mailbox (info@, admin@)?
//   5. Free     — is it a consumer free-webmail address vs a business domain?
//   6. SMTP     — (deep) live RCPT-TO probe of the real MX to see if the
//                 specific MAILBOX exists, plus catch-all detection. No mail is
//                 ever sent (no DATA). Degrades honestly if port 25 is blocked.
//
// Output: VALID / INVALID / RISKY verdict + reasons + a 0-100 deliverability
// score. Nothing is invented — when a live check can't run we say so.

import { promises as dns } from "node:dns";
import { isDisposableDomain } from "./disposable.js";
import { ROLE_LOCALPARTS, FREE_PROVIDERS, GMAIL_TYPOS } from "./catalogs.js";
import { probeMailbox, type SmtpProbeResult } from "./smtp.js";

export type Verdict = "VALID" | "INVALID" | "RISKY" | "UNKNOWN";

export interface Reason {
  code: string;
  severity: "info" | "low" | "medium" | "high";
  message: string;
}

export interface VerifyResult {
  email: string;
  verdict: Verdict;
  score: number; // 0 (won't deliver) .. 100 (high confidence deliverable)
  deliverable: boolean | null; // null = could not determine the mailbox itself
  reasons: Reason[];
  checks: {
    syntaxValid: boolean;
    domain: string | null;
    domainResolves: boolean | null;
    hasMx: boolean | null;
    mxHosts: string[];
    disposable: boolean;
    roleBased: boolean;
    freeProvider: boolean;
    catchAll: boolean | null; // null = not tested
    smtp: {
      tested: boolean;
      status: SmtpProbeResult["status"] | null;
      code: number | null;
      message: string | null;
      mxHost: string | null;
    };
  };
  checkedAt: string;
}

// RFC 5321/5322-pragmatic email regex: one @, sane local part, dotted domain.
// Deliberately not the monster RFC regex — this matches what real MTAs accept.
const EMAIL_RE =
  /^(?=.{1,254}$)(?=.{1,64}@)[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

function syntaxIssues(email: string): { valid: boolean; reasons: Reason[] } {
  const reasons: Reason[] = [];
  if (!email || typeof email !== "string") {
    return { valid: false, reasons: [{ code: "empty", severity: "high", message: "No email provided." }] };
  }
  const e = email.trim();
  if (e !== email) reasons.push({ code: "whitespace", severity: "low", message: "Address had surrounding whitespace." });
  if (!e.includes("@")) {
    reasons.push({ code: "no_at", severity: "high", message: "Missing '@' — not an email address." });
    return { valid: false, reasons };
  }
  if (e.split("@").length !== 2) {
    reasons.push({ code: "multi_at", severity: "high", message: "Contains more than one '@'." });
    return { valid: false, reasons };
  }
  const [local, domain] = e.split("@");
  if (local.length === 0) reasons.push({ code: "empty_local", severity: "high", message: "Empty local part (before '@')." });
  if (local.length > 64) reasons.push({ code: "local_too_long", severity: "high", message: "Local part exceeds 64 chars." });
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    reasons.push({ code: "bad_dots", severity: "high", message: "Local part has leading/trailing/consecutive dots." });
  }
  if (!domain.includes(".")) reasons.push({ code: "domain_no_tld", severity: "high", message: "Domain has no TLD." });
  if (domain.length > 255) reasons.push({ code: "domain_too_long", severity: "high", message: "Domain exceeds 255 chars." });

  const ok = EMAIL_RE.test(e) && !reasons.some((r) => r.severity === "high");
  return { valid: ok, reasons };
}

async function resolveMx(domain: string): Promise<{ resolves: boolean | null; mxHosts: string[]; hasMx: boolean | null }> {
  let mxHosts: string[] = [];
  let hasMx: boolean | null = null;
  let resolves: boolean | null = null;
  try {
    const mx = await dns.resolveMx(domain);
    if (mx && mx.length) {
      mxHosts = mx
        .filter((r) => r.exchange)
        .sort((a, b) => a.priority - b.priority)
        .map((r) => r.exchange.replace(/\.$/, ""));
      hasMx = mxHosts.length > 0;
      resolves = true;
    } else {
      hasMx = false;
    }
  } catch (err: any) {
    if (err && (err.code === "ENOTFOUND" || err.code === "ENODATA")) {
      hasMx = false;
    } else {
      hasMx = null; // DNS error — inconclusive
    }
  }

  // If no MX, an A/AAAA record can still accept mail (implicit MX per RFC 5321).
  if (hasMx === false || resolves === null) {
    try {
      const a = await dns.lookup(domain).catch(() => null);
      if (a && a.address) {
        resolves = true;
        if (hasMx === false) {
          mxHosts = [domain]; // implicit MX = the A record host
          hasMx = false; // record that there is no explicit MX
        }
      } else if (resolves === null) {
        resolves = false;
      }
    } catch {
      if (resolves === null) resolves = false;
    }
  }

  return { resolves, mxHosts, hasMx };
}

export interface VerifyOptions {
  deep?: boolean; // run the live SMTP RCPT probe
}

export async function verifyEmail(rawEmail: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const email = String(rawEmail ?? "").trim();
  const reasons: Reason[] = [];
  const checkedAt = new Date().toISOString();

  // 1. Syntax
  const syn = syntaxIssues(email);
  reasons.push(...syn.reasons);
  const domain = email.includes("@") ? email.split("@")[1]?.toLowerCase() ?? null : null;
  const local = email.includes("@") ? email.split("@")[0]?.toLowerCase() ?? "" : "";

  const baseChecks: VerifyResult["checks"] = {
    syntaxValid: syn.valid,
    domain,
    domainResolves: null,
    hasMx: null,
    mxHosts: [],
    disposable: false,
    roleBased: false,
    freeProvider: false,
    catchAll: null,
    smtp: { tested: false, status: null, code: null, message: null, mxHost: null },
  };

  if (!syn.valid || !domain) {
    return {
      email,
      verdict: "INVALID",
      score: 0,
      deliverable: false,
      reasons: reasons.length ? reasons : [{ code: "invalid_syntax", severity: "high", message: "Address is not syntactically valid." }],
      checks: baseChecks,
      checkedAt,
    };
  }

  // Typo detection on common domains
  if (GMAIL_TYPOS.has(domain)) {
    reasons.push({ code: "domain_typo", severity: "high", message: `'${domain}' looks like a typo of a major provider.` });
  }

  // 2. Domain / MX
  const { resolves, mxHosts, hasMx } = await resolveMx(domain);
  baseChecks.domainResolves = resolves;
  baseChecks.hasMx = hasMx;
  baseChecks.mxHosts = mxHosts;

  // 3. Disposable
  const disposable = isDisposableDomain(domain);
  baseChecks.disposable = disposable;
  if (disposable) reasons.push({ code: "disposable", severity: "high", message: `'${domain}' is a known disposable / temporary email provider.` });

  // 4. Role-based
  const roleBased = ROLE_LOCALPARTS.has(local);
  baseChecks.roleBased = roleBased;
  if (roleBased) reasons.push({ code: "role_based", severity: "medium", message: `'${local}@' is a role/shared mailbox, not a personal inbox.` });

  // 5. Free provider
  const freeProvider = FREE_PROVIDERS.has(domain);
  baseChecks.freeProvider = freeProvider;
  if (freeProvider) reasons.push({ code: "free_provider", severity: "info", message: `'${domain}' is a consumer free-webmail provider.` });

  // Domain-level verdicts that short-circuit
  if (resolves === false) {
    reasons.push({ code: "domain_not_found", severity: "high", message: `Domain '${domain}' does not resolve — cannot receive mail.` });
    return { email, verdict: "INVALID", score: 0, deliverable: false, reasons, checks: baseChecks, checkedAt };
  }
  if (hasMx === false && mxHosts.length === 0) {
    reasons.push({ code: "no_mx", severity: "high", message: `Domain '${domain}' has no MX (or A) record — cannot receive mail.` });
    return { email, verdict: "INVALID", score: 5, deliverable: false, reasons, checks: baseChecks, checkedAt };
  }
  if (hasMx === false && mxHosts.length > 0) {
    reasons.push({ code: "implicit_mx", severity: "low", message: `No explicit MX; mail would fall back to the A record (${mxHosts[0]}).` });
  }
  if (hasMx === true) {
    reasons.push({ code: "has_mx", severity: "info", message: `Domain has ${mxHosts.length} MX host(s); top: ${mxHosts[0]}.` });
  }

  // 6. SMTP live probe (deep)
  let smtp: SmtpProbeResult | null = null;
  if (opts.deep && mxHosts.length > 0) {
    try {
      smtp = await probeMailbox(email, mxHosts);
      baseChecks.smtp = {
        tested: true,
        status: smtp.status,
        code: smtp.code,
        message: smtp.message,
        mxHost: smtp.mxHost,
      };
      baseChecks.catchAll = smtp.catchAll;
      switch (smtp.status) {
        case "deliverable":
          reasons.push({ code: "smtp_accept", severity: "info", message: `Mailbox accepted by ${smtp.mxHost} (SMTP ${smtp.code}). The inbox exists.` });
          break;
        case "undeliverable":
          reasons.push({ code: "smtp_reject", severity: "high", message: `Mailbox rejected by ${smtp.mxHost} (SMTP ${smtp.code}). The inbox does not exist.` });
          break;
        case "catch_all":
          reasons.push({ code: "catch_all", severity: "medium", message: `Domain is catch-all — it accepts ANY address, so mailbox existence can't be confirmed.` });
          break;
        case "greylisted":
          reasons.push({ code: "greylisted", severity: "low", message: `Server greylisted the probe (SMTP ${smtp.code}); mailbox existence inconclusive.` });
          break;
        case "blocked":
          reasons.push({ code: "smtp_blocked", severity: "info", message: `Live SMTP probe could not run (outbound port 25 blocked on this host). Verdict uses MX + syntax + disposable signals only.` });
          break;
        default:
          reasons.push({ code: "smtp_unknown", severity: "low", message: `SMTP probe inconclusive on ${smtp.mxHost}.` });
      }
    } catch (err: any) {
      reasons.push({ code: "smtp_error", severity: "info", message: `SMTP probe error: ${String(err?.message ?? err)}. Degraded to MX-level checks.` });
    }
  }

  // ---- Scoring & verdict --------------------------------------------------
  let score = 50;
  let deliverable: boolean | null = null;

  if (hasMx === true) score += 25;
  if (mxHosts.length > 0) score += 5;
  if (freeProvider) score += 10; // well-behaved, real mailboxes are the norm

  if (smtp?.status === "deliverable") { score += 35; deliverable = true; }
  else if (smtp?.status === "undeliverable") { score = Math.min(score, 8); deliverable = false; }
  else if (smtp?.status === "catch_all") { score = Math.min(score, 60); deliverable = null; }
  else if (smtp?.status === "greylisted" || smtp?.status === "unknown") { deliverable = null; }

  if (disposable) score = Math.min(score, 15);
  if (roleBased) score -= 15;
  if (GMAIL_TYPOS.has(domain)) score = Math.min(score, 10);

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict: Verdict;
  if (smtp?.status === "undeliverable" || disposable || GMAIL_TYPOS.has(domain)) {
    verdict = disposable || GMAIL_TYPOS.has(domain) ? "RISKY" : "INVALID";
    if (smtp?.status === "undeliverable") verdict = "INVALID";
  } else if (smtp?.status === "deliverable" && !roleBased) {
    verdict = "VALID";
  } else if (roleBased || smtp?.status === "catch_all" || smtp?.status === "greylisted") {
    verdict = "RISKY";
  } else if (hasMx === true || mxHosts.length > 0) {
    // MX exists, no live mailbox confirmation -> deliverable likely but unproven
    verdict = score >= 70 ? "VALID" : "RISKY";
  } else {
    verdict = "UNKNOWN";
  }

  return { email, verdict, score, deliverable, reasons, checks: baseChecks, checkedAt };
}
