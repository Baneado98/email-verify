// Static catalogs used by the verifier, embedded so checks are instant.

// Role-based local-parts: shared mailboxes that belong to a function, not a
// person. Sending marketing/transactional mail to these tends to hurt
// deliverability and they are usually filtered out of clean lists.
export const ROLE_LOCALPARTS: ReadonlySet<string> = new Set([
  "abuse", "admin", "administrator", "billing", "compliance", "contact",
  "devnull", "dns", "ftp", "help", "hello", "helpdesk", "hostmaster", "info",
  "inoc", "ispfeedback", "ispsupport", "list", "list-request", "mail",
  "mailer-daemon", "marketing", "media", "news", "newsletter", "noc", "noreply",
  "no-reply", "notifications", "office", "ops", "orders", "postmaster",
  "privacy", "remove", "root", "sales", "security", "service", "spam",
  "subscribe", "support", "sysadmin", "team", "unsubscribe", "usenet", "uucp",
  "webmaster", "welcome", "www",
]);

// Major free webmail providers — used to flag "free provider" (a person, not a
// business domain) and to know these are catch-all-unlikely, well-behaved MX.
export const FREE_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.uk", "yahoo.fr",
  "ymail.com", "rocketmail.com", "hotmail.com", "hotmail.co.uk", "hotmail.fr",
  "outlook.com", "outlook.fr", "live.com", "msn.com", "aol.com", "icloud.com",
  "me.com", "mac.com", "gmx.com", "gmx.de", "gmx.net", "web.de", "mail.com",
  "zoho.com", "zohomail.com", "yandex.com", "yandex.ru", "protonmail.com",
  "proton.me", "pm.me", "fastmail.com", "hey.com", "tutanota.com", "tuta.io",
]);

// Common typos of gmail.com → flag as likely-mistyped (deliverability risk).
export const GMAIL_TYPOS: ReadonlySet<string> = new Set([
  "gmial.com", "gmai.com", "gmal.com", "gmail.co", "gmail.con", "gmail.cm",
  "gmaill.com", "gmail.comm", "gnail.com", "gmail.om", "gmailcom", "gmail.cmo",
  "gemail.com", "gmaul.com", "gmali.com", "ggmail.com", "yahooo.com",
  "yaho.com", "hotmial.com", "hotmal.com", "hotnail.com", "outlok.com",
  "outloo.com", "outlock.com",
]);
