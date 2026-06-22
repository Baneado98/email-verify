// Keep the static public/index.html in sync with the LANDING_HTML constant in
// src/server.ts. Vercel serves public/index.html for "/" directly (faster, SEO),
// so it must mirror the app's landing markup. Runs on `npm run build`.
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");
const m = src.match(/const LANDING_HTML = `([\s\S]*?)`;/);
if (!m) {
  console.error("sync-landing: LANDING_HTML constant not found in src/server.ts");
  process.exit(1);
}
writeFileSync(new URL("../public/index.html", import.meta.url), m[1]);
console.log("sync-landing: public/index.html updated (" + m[1].length + " chars)");
