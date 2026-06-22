// Deterministic, offline-safe tests for the email-verify engine.
// These avoid asserting on live DNS/SMTP (which vary by network); they exercise
// syntax validation, the disposable catalog, role detection and typo flags —
// the deterministic core. Run with: npm run test:engine
import assert from "node:assert";
import { verifyEmail } from "./engine.js";
import { isDisposableDomain } from "./disposable.js";
import { ROLE_LOCALPARTS } from "./catalogs.js";

let passed = 0;
async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err: any) {
    console.error(`FAIL  ${name}\n      ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}

(async () => {
  // --- syntax ---
  await t("rejects address with no @", async () => {
    const r = await verifyEmail("notanemail");
    assert.equal(r.verdict, "INVALID");
    assert.equal(r.checks.syntaxValid, false);
    assert.equal(r.score, 0);
  });

  await t("rejects double @", async () => {
    const r = await verifyEmail("a@@b.com");
    assert.equal(r.verdict, "INVALID");
  });

  await t("rejects empty local part", async () => {
    const r = await verifyEmail("@example.com");
    assert.equal(r.verdict, "INVALID");
  });

  await t("rejects domain with no TLD", async () => {
    const r = await verifyEmail("jane@localhost");
    assert.equal(r.checks.syntaxValid, false);
  });

  await t("rejects consecutive dots in local part", async () => {
    const r = await verifyEmail("ja..ne@example.com");
    assert.equal(r.checks.syntaxValid, false);
  });

  await t("accepts a well-formed address syntactically", async () => {
    const r = await verifyEmail("jane.doe+tag@example.com");
    assert.equal(r.checks.syntaxValid, true);
  });

  // --- disposable catalog ---
  await t("flags a known disposable domain", () => {
    assert.equal(isDisposableDomain("mailinator.com"), true);
    assert.equal(isDisposableDomain("10minutemail.com"), true);
    assert.equal(isDisposableDomain("temp-mail.org"), true);
  });

  await t("does not flag a normal domain as disposable", () => {
    assert.equal(isDisposableDomain("example.com"), false);
    assert.equal(isDisposableDomain("microsoft.com"), false);
  });

  await t("flags disposable subdomain via suffix match", () => {
    assert.equal(isDisposableDomain("foo.mailinator.com"), true);
  });

  // --- role-based ---
  await t("role local-parts catalog includes the usual suspects", () => {
    for (const r of ["info", "admin", "support", "sales", "postmaster", "noreply"]) {
      assert.ok(ROLE_LOCALPARTS.has(r), `${r} should be role-based`);
    }
  });

  // --- typo ---
  await t("flags a gmail typo domain as RISKY", async () => {
    const r = await verifyEmail("jane@gmial.com");
    assert.ok(["RISKY", "INVALID"].includes(r.verdict));
    assert.ok(r.reasons.some((x) => x.code === "domain_typo"));
  });

  // --- structure of result ---
  await t("result always carries checks + checkedAt", async () => {
    const r = await verifyEmail("jane@example.com");
    assert.ok(typeof r.checkedAt === "string");
    assert.ok(typeof r.checks === "object");
    assert.ok(["VALID", "RISKY", "INVALID", "UNKNOWN"].includes(r.verdict));
  });

  console.log(`\nengine.test: ${passed} checks passed.`);
})();
