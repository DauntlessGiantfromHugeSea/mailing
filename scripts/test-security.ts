// Regressionstests zum Sicherheits-Audit 2026-10 (ohne DB/Netz).
// Aufruf: npx tsx scripts/test-security.ts
import assert from "node:assert/strict";
import { ensureUnsubscribeFooter, renderHtml, render } from "../src/lib/templates";
import { assertSmtpTarget, istPrivateAdresse } from "../src/lib/smtpTarget";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";

const rng = () => 0.1;
const vars = { firstName: "Max <b>x</b>", lastName: "<!--", company: "{{unsubscribe}}", unsubscribeUrl: "https://m.example/abmelden?token=T1" };

// 1) Platzhalter werden in HTML maskiert, im Betreff nicht
const html = renderHtml("<p>Hallo {{firstName}} {{lastName}} ({{company}})</p>", vars, rng);
assert.ok(html.includes("Max &lt;b&gt;x&lt;/b&gt;"), html);
assert.ok(!html.includes("<!--"), html);
assert.equal(render("Hallo {{firstName}}", vars, rng), "Hallo Max <b>x</b>");

// 2) Footer: ein wörtliches {{unsubscribe}} aus Kontaktdaten unterdrückt ihn nicht
const mitFooter = ensureUnsubscribeFooter(html, vars.unsubscribeUrl);
assert.ok(mitFooter.includes('href="https://m.example/abmelden?token=T1"'), mitFooter);
// Vorlage mit eigenem Abmeldelink bekommt keinen zweiten Footer
const eigen = renderHtml('<a href="{{unsubscribe}}">ab</a>', vars, rng);
assert.equal(ensureUnsubscribeFooter(eigen, vars.unsubscribeUrl), eigen);

// 3) SMTP-Ziele
for (const ip of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.0.1", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
  assert.ok(istPrivateAdresse(ip), ip);
}
assert.ok(!istPrivateAdresse("8.8.8.8"));

async function main() {
  await assert.rejects(assertSmtpTarget("127.0.0.1", 465));
  await assert.rejects(assertSmtpTarget("smtp.hostinger.com", 2401));
  await assert.rejects(assertSmtpTarget("bad host!", 465));

  // 4) CSRF: fremde Seite -> 403, eigene Seite -> durch
  const fremd = new NextRequest("https://mailing.example.test/api/contacts/x/actions", {
    method: "POST", headers: { "sec-fetch-site": "same-site", host: "mailing.example.test" },
  });
  assert.equal(middleware(fremd).status, 403);
  const fremdOrigin = new NextRequest("https://mailing.example.test/api/contacts/x/actions", {
    method: "POST", headers: { origin: "https://evil.example", host: "mailing.example.test" },
  });
  assert.equal(middleware(fremdOrigin).status, 403);
  const eigen = new NextRequest("https://mailing.example.test/api/auth/login", {
    method: "POST", headers: { "sec-fetch-site": "same-origin", host: "mailing.example.test" },
  });
  assert.notEqual(middleware(eigen).status, 403);
  const maschine = new NextRequest("https://mailing.example.test/api/integration/verteiler", {
    method: "POST", headers: { "sec-fetch-site": "cross-site" },
  });
  assert.notEqual(middleware(maschine).status, 403);
  console.log("Sicherheits-Regressionstests: OK");
}
main().catch((e) => { console.error(e); process.exit(1); });
