# Befund-Details – Mailing-Tool (mailing)

Enthält alle bestätigten Befunde der Schwere mittel oder höher mit Trace, lokaler Reproduktion und Fix.

## VIEWER liest über /api/campaigns/preview-html den Abmelde-Token (und verborgene Zusatzfelder) beliebiger Kontakte und kann diese damit abmelden

- Schwere: **mittel** – Fingerprint `mailing:api/campaigns/preview-html:viewer-reads-contact-unsubscribe-token`
- Stand: behoben – Vorschau nur für EDITOR/ADMIN, immer Beispiel-Abmeldelink

**Beschreibung.** Die HTML-Vorschau-API prüft nur, ob eine Session existiert. Ein Nur-lesen-Benutzer (VIEWER) kann für jede contactId (aus dem RSC-Payload von /contacts ablesbar) die gerenderte Mail abrufen. Diese enthält die echte Abmelde-URL des Kontakts mit dessen unsubscribeToken – den einzigen Berechtigungsnachweis der öffentlichen Seite /abmelden – sowie alle customFields, die sonst nirgends in der UI angezeigt werden. Der Abmeldelink wird per ensureUnsubscribeFooter sogar dann angehängt, wenn der Text keinen Platzhalter enthält. Ein Aufruf von /abmelden?token=… setzt den Kontakt ohne weitere Prüfung auf UNSUBSCRIBED, legt eine Sperre mit Grund 'unsubscribe' an und bricht offene Sendungen ab – ohne Audit-Eintrag und nicht von einer echten Empfänger-Abmeldung unterscheidbar. Damit kann ein VIEWER beliebige oder alle Kontakte sperren, obwohl das RBAC-Modell Sperren EDITOR/ADMIN vorbehält (und dort auditiert).

**Soll-Verhalten.** Vorschauen mit echten Kontaktdaten sind nur EDITOR/ADMIN vorbehalten (die einzige UI dafür, /campaigns/new mit CampaignForm/MailPreview, ist editor-only), und keine Vorschau darf einen gültigen Abmelde-Token ausliefern, weil dieser eine Zustandsänderung (Sperre) autorisiert, die VIEWER nicht vornehmen dürfen.

**Trace**

1. `src/app/api/campaigns/preview-html/route.ts:43` (entrypoint) – JSON-Endpunkt hinter der Middleware (nur Cookie-Präsenz); Z. 44-45 prüfen nur, dass eine Session existiert – kein canEdit.
2. `src/app/contacts/page.tsx:265` (propagation) – Für jede Session (Z. 21-22, auch VIEWER) wird <tr key={c.id}> in einer Server-Komponente gerendert; der Key steht im eingebetteten RSC-Flight-Payload, d. h. VIEWER erhält alle Kontakt-IDs seitenweise.
3. `src/app/api/campaigns/preview-html/route.ts:56` (propagation) – Lädt einen beliebigen Kontakt per Body-contactId ohne Rollen- oder Statusbindung und übernimmt contactVars() als Variablen (Z. 58-59).
4. `src/lib/templates.ts:54` (propagation) – unsubscribeUrl wird aus dem echten contact.unsubscribeToken gebaut; customFields werden in Z. 48 vollständig eingemischt.
5. `src/app/api/campaigns/preview-html/route.ts:71` (propagation) – ensureUnsubscribeFooter(…, unsub) hängt die echte Abmelde-URL auch ohne Platzhalter im Text an; das HTML wird in Z. 89 an den Aufrufer zurückgegeben.
6. `src/app/abmelden/page.tsx:18` (propagation) – Öffentliche GET-Seite (PUBLIC_PREFIXES, src/middleware.ts:19) ruft unsubscribeByToken(token) sofort beim Aufruf auf; der Token ist der einzige Berechtigungsnachweis.
7. `src/lib/contacts.ts:284` (sink) – Setzt status UNSUBSCRIBED (Z. 284-287), legt Sperre mit reason 'unsubscribe' an (Z. 288-292) und setzt PENDING-Jobs auf SKIPPED (Z. 294-297); kein audit()-Aufruf, keine Akteurszuordnung.

**Belege**

- `src/lib/rbac.ts:8` – Soll-Policy: canEdit (ADMIN/EDITOR) ist für Änderungen an Kontakten/Sperren erforderlich.
- `src/app/api/contacts/[id]/actions/route.ts:13` – Der direkte Sperrpfad verlangt canEdit und protokolliert per audit(); VIEWER wird abgewiesen (vom Hunter lokal beobachtet: 303 ?error=Keine Berechtigung, 0 Writes).
- `src/app/campaigns/new/page.tsx:22` – Die einzige UI, die die Vorschau mit echtem Kontakt anbietet (CampaignForm → MailPreview), leitet Nicht-Bearbeiter um.
- `src/app/api/campaigns/preview-html/route.ts:45` – Einzige Prüfung ist `if (!session)`; kein canEdit, anders als bei allen schreibenden Kontakt-/Kampagnen-Routen.
- `src/lib/templates.ts:98` – ensureUnsubscribeFooter fügt `<a href="${url}">` mit dem echten Token ein, wenn der Text ihn nicht enthält.
- `src/lib/contacts.ts:280` – unsubscribeByToken enthält keinen audit()-Aufruf – gefälschte Abmeldungen sind von echten nicht unterscheidbar.
- `src/lib/verteilerSync.ts:258` – Sperren mit reason 'unsubscribe' werden dem FBE-Verteiler beim nächsten Abgleich als 'abgemeldet' zurückgemeldet, sofern der Verteiler die Adresse in `check` (Z. 245) abfragt (abgeleitete Kopie in einem anderen System).
- `src/lib/authMicrosoft.ts:65` – Standardrolle für automatisch angelegte Microsoft-Konten ist VIEWER (MICROSOFT_DEFAULT_ROLE, Z. 65-67).
- `agents/v3-ml-03/artifacts/v3-ml-03-repro.txt:1` – Unabhängige Reproduktion des Verifiers in der OS-Sandbox mit echter preview-html-Route und echtem unsubscribeByToken (Stub-Session/Stub-DB): VIEWER erhält echten Token und verborgenes Zusatzfeld; Token-Einlösung erzeugt contact.update, suppression.upsert, sendJob.updateMany ohne auditLog.create.
- `agents/ml-h3/artifacts/ml-h3-rsc-key.txt:1` – Hunter-Nachweis: Next' gebündelter react-server-dom-webpack serialisiert den React-Key als ["$","tr","ckdummycontact0001",…] in den Flight-Payload.

**Akteur (Dummy).** Angemeldeter VIEWER (Nur-lesen-Rolle) im Mailing-Tool.

**Lokale Reproduktion.** ['In der OS-Sandbox (kein Netz, Dummy-Env FIELD_ENCRYPTION_KEY=00..01, APP_URL=https://mailing.example.invalid) die echte Route src/app/api/campaigns/preview-html/route.ts per tsx laden; @/lib/session auf einen Stub mit Rolle aus ROLE und @/lib/db/globalThis.prisma auf einen In-Memory-Stub mit einem Dummy-Kontakt (Token V3TOK-0123456789abcdef, customFields {intern: HIDDEN-V3}) abbilden.', 'Kontrolle A: POST ohne contactId → HTML enthält nur BEISPIEL-TOKEN.', 'B: POST mit contactId und Text ohne Platzhalter → prüfen, ob das HTML den echten Token enthält (Fußzeilen-Pfad).', 'C: POST mit Betreff {{intern}} → prüfen, ob das verborgene Zusatzfeld zurückkommt.', 'D: Den extrahierten Token an das echte unsubscribeByToken() aus src/lib/contacts.ts übergeben und die DB-Aufrufe protokollieren. Alles für ROLE=VIEWER und ROLE=EDITOR.']

**Beobachtet.** ROLE=VIEWER: A → 200, nur BEISPIEL-TOKEN; B → 200, HTML enthält V3TOK-0123456789abcdef (über die automatisch angehängte Fußzeile); C → 200, subject 'HIDDEN-V3'; D → contact.update, suppression.upsert, sendJob.updateMany, kein auditLog.create. ROLE=EDITOR identisch (keine Rollenabhängigkeit). Der canEdit-geschützte Sperrpfad weist VIEWER ab (Hunter-Artefakt ml-h3-viewer-preview-token.txt).

**Voraussetzungen.** Angreifer besitzt eine gültige Session (ml_session-JWT).; Rolle VIEWER genügt (Standardrolle für per Microsoft-Login automatisch angelegte Konten, sofern MICROSOFT_* konfiguriert).; Zielkontakte existieren; ihre IDs stammen aus dem RSC-Payload von /contacts (seitenweise, 50 pro Seite).

**Fix.** In preview-html canEdit verlangen (403 sonst) und in jeder Vorschau die echte Abmelde-URL durch SAMPLE.unsubscribeUrl ersetzen, bevor gerendert und die Fußzeile angehängt wird. Regressionstests: (1) VIEWER-Session + contactId → 403, kein prisma.contact.findUnique; (2) EDITOR-Session + contactId → 200 und weder html noch text noch subject enthalten contact.unsubscribeToken, wohl aber BEISPIEL-TOKEN. Härtung: audit() in unsubscribeByToken (ohne Akteur, mit Quelle 'token'), damit Massenabmeldungen auffallen.

**Vorgeschlagene Code-Änderung (Audit-Vorschlag; umgesetzte Fassung siehe Commit)**

`src/app/api/campaigns/preview-html/route.ts`

```
import { canEdit } from "@/lib/rbac";
...
  const session = await getSession();
  if (!session) return jsonError("Nicht angemeldet", 401);
  if (!canEdit(session)) return jsonError("Keine Berechtigung", 403);
...
    if (contact) {
      const v = contactVars(contact);
      // Vorschau nie mit echtem Abmelde-Token ausliefern.
      vars = { ...v, unsubscribeUrl: SAMPLE.unsubscribeUrl };
...
  const unsub = SAMPLE.unsubscribeUrl;
```

## Kontaktfelder werden ungeescaped in den HTML-Body von Kampagnenmails eingesetzt (HTML-Injection, versteckter/unterdrückter Abmelde-Footer)

- Schwere: **mittel** – Fingerprint `mailing:src/lib/templates.ts:fillPlaceholders:contact-fields-unescaped-into-html-body`
- Stand: behoben – Platzhalter im HTML werden escaped

**Beschreibung.** fillPlaceholders (src/lib/templates.ts:76-87) setzt entschlüsselte Kontaktwerte (firstName, lastName, fullName, company, Custom-Felder) unverändert in campaign.bodyHtml ein; worker.ts:212 versendet das Ergebnis als text/html über den Firmen-Absender. Kontaktnamen stammen u. a. aus dem FBE-Verteiler (/api/integration/verteiler, Schema nur Längenlimit 200). Der Verteiler übernimmt beim Postfach-Import Anzeigenamen aus From/To/Cc externer Mails und Namen aus 'Name <adresse>'-Mustern im Mailtext ohne HTML-Bereinigung (nur clean_text), legt die Adressen als 'aktiv' an und überträgt sie im Segment 'alle_aktiven' ans Mailing-Tool. Damit kann ein externer, nicht authentifizierter Absender durch eine einzige Mail an das überwachte Firmenpostfach für eine beliebige Dritt-Adresse Markup in den Namen setzen, das später in einer firmengebrandeten Kampagnenmail an diese Adresse als HTML erscheint: Links/Formatierung (Phishing mit Firmenreputation), ein offenes '<!--', das den automatisch angehängten Abmelde-Footer in einen Kommentar schiebt, oder ein wörtliches '{{unsubscribe}}', das ensureUnsubscribeFooter (templates.ts:98) dazu bringt, den Footer gar nicht anzuhängen (Mail ohne Abmeldelink im Body; nur der List-Unsubscribe-Header bleibt). Lokal Ende-zu-Ende reproduziert (Verteiler-Postfachlogik -> Segment-Nutzlast -> contactVars/render/ensureUnsubscribeFooter -> nodemailer-MIME).

**Soll-Verhalten.** Kontaktwerte sind nicht vertrauenswürdige Daten: im HTML-Body müssen sie HTML-escaped eingesetzt werden (Betreff/bodyText bleiben Klartext), und der Abmelde-Footer darf nur entfallen, wenn die tatsächliche Abmelde-URL des Empfängers im gerenderten HTML steht – Kontaktdaten dürfen den Footer weder unterdrücken noch verstecken.

**Trace**

1. `projektabrechung/verteiler/verteiler_core/postfach.py:407` (entrypoint) – Externer Absender bestimmt Anzeigenamen in From/To/Cc (emailAddress.name) und 'Name <adresse>'-Muster im Mailtext einer Mail an das überwachte Firmenpostfach; jede genannte Fremdadresse wird aufgenommen.
2. `projektabrechung/verteiler/verteiler_core/postfach.py:344` (propagation) – Nur clean_text (Steuerzeichen/Whitespace) und Klammer-Entfernung; '<', '>', '{{', '}}' bleiben erhalten und landen als Vorname/Nachname.
3. `projektabrechung/verteiler/verteiler_core/postfach.py:630` (propagation) – analysiere_kontakte/kontakte_schreiben legen die Adressen mit Quelle 'Postfach: …' und Standardstatus 'aktiv' an.
4. `projektabrechung/verteiler/verteiler_core/mailing.py:198` (propagation) – Segment-Kontakte (Standard 'alle_aktiven') werden als firstName/lastName/company an POST /api/integration/verteiler übertragen.
5. `src/lib/verteilerSync.ts:72` (propagation) – Mailing-Tool akzeptiert Namen als beliebige Strings bis 200 Zeichen; runSync übergibt sie an upsertContacts (Zeile 199).
6. `src/lib/contacts.ts:66` (propagation) – Werte werden unverändert verschlüsselt gespeichert.
7. `src/lib/templates.ts:79` (propagation) – vars[key] wird roh in die Vorlage eingesetzt – kein HTML-Escaping.
8. `src/lib/templates.ts:98` (propagation) – Footer entfällt, wenn der gerenderte Text ein wörtliches '{{unsubscribe}}' enthält; bei '<!--' im Wert landet der angehängte Footer im offenen Kommentar.
9. `src/lib/mailer.ts:117` (sink) – Gerendertes HTML wird als text/html-Teil über den SMTP-Absender der Firma an die Kontaktadresse versendet.

**Belege**

- `src/lib/templates.ts:76` – fillPlaceholders: template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, …) gibt den Rohwert zurück; einziger Ausgabekontext.
- `src/lib/templates.ts:98` – ensureUnsubscribeFooter prüft /\{\{\s*unsubscribe(Url)?\s*\}\}/ auf dem gerenderten HTML.
- `src/lib/worker.ts:212` – bodyHtml wird mit demselben render() wie Betreff/bodyText erzeugt; keine Escaping-Schicht bis zum Versand (grep: kein escape/sanitize in src/).
- `src/lib/verteilerSync.ts:62` – text(max) = z.string().max(max) – nur Längenbegrenzung.
- `projektabrechung/verteiler/verteiler_core/postfach.py:334` – _NAME_UND_ADRESSE erlaubt im Namensteil des Mailtexts '{{…}}' (nicht aber <>); Header-Anzeigenamen (Zeile 407-410) sind gar nicht zeichenbeschränkt.
- `agents/v3-ml-05/artifacts/stage1_out.txt:1` – Lokal (Sandbox, ohne Netz): Dummy-Graph-Nachricht eines externen Absenders mit Cc 'Max <!--' <victim-a@…>, 'Max <b>x</b>' <victim-b@…> und Textzeile 'Von: {{unsubscribe}} Muster <victim-c@…>' ergibt im Verteiler aktive Kontakte und eine Mailing-Nutzlast mit lastName '<!--', lastName '<b>x</b>' bzw. firstName '{{unsubscribe}}' (Skript stage1_verteiler.py).
- `agents/v3-ml-05/artifacts/stage2_out.txt:1` – Dieselbe Nutzlast durch contactVars→render→ensureUnsubscribeFooter→nodemailer: victim-b raw_b_tag_in_html=true; victim-a footer_inside_unclosed_comment=true; victim-c footer_link_in_html=false (gerendert nur '<p>Hallo {{unsubscribe}} Muster,</p><p>Neuigkeiten.</p>'), List-Unsubscribe-Header jeweils vorhanden (Skript stage2_mailing.js).

**Akteur (Dummy).** Externer, nicht authentifizierter Absender, der eine Mail an das vom Verteiler überwachte Firmenpostfach schicken kann; Ziel ist eine beliebige Dritt-Adresse (Dummy victim-*@example.org).

**Lokale Reproduktion.** ["Sandbox (kein Netz, nobody, leere Umgebung): python3 -I - < stage1_verteiler.py führt postfach.adressen_aus_mail, imports.analysiere_kontakte/kontakte_schreiben (SQLite in /tmp der Sandbox) und queries.segment_kontakte('alle_aktiven') auf einer Dummy-Graph-Nachricht aus und baut die Nutzlast wie mailing.abgleichen (Zeile 198-200).", "env FIELD_ENCRYPTION_KEY=<Dummy-64-Hex> APP_URL=https://mailing.example.test node - < stage2_mailing.js lädt src/lib/crypto.ts und src/lib/templates.ts (transpiliert, read-only), rendert '<p>Hallo {{firstName}} {{lastName}},</p><p>Neuigkeiten.</p>' wie worker.ts:209-212 und baut die Mail per nodemailer streamTransport (kein Versand).", "Ausgaben stage1_out.txt/stage2_out.txt prüfen: rohes '<b>x</b>' im HTML, Footer nach offenem '<!--', Footer fehlt bei '{{unsubscribe}}'."]

**Beobachtet.** victim-b: rendered_html '<p>Hallo Max <b>x</b>,</p>…' (raw_b_tag_in_html=true, kein &lt;). victim-a: '<p>Hallo Max <!--,</p>…' mit angehängtem Footer innerhalb des nicht geschlossenen Kommentars (footer_inside_unclosed_comment=true). victim-c: '<p>Hallo {{unsubscribe}} Muster,</p><p>Neuigkeiten.</p>' ohne Abmelde-Footer (footer_link_in_html=false); List-Unsubscribe-Header bleibt gesetzt. Kontrollfall sender@extern.example mit normalem Namen erhält den Footer regulär.

**Voraussetzungen.** Im Verteiler sind Postfach-Abruf (postfach_aktiv) und Mailing-Abgleich (mailing_aktiv) eingeschaltet; beide sind im Code standardmäßig aus, laut Projektnotiz aber vorgesehen (Container verteiler-hintergrund). Segment muss die importierten Kontakte enthalten (Standard 'alle_aktiven' tut das).; Die Kampagnenvorlage verwendet einen Namensplatzhalter ({{firstName}}, {{lastName}}, {{fullName}}, {{vorname}}, …), und die Zieladresse hat im Verteiler noch keinen Namen (Modus 'ergaenzen' füllt nur leere Felder) bzw. ist neu.; Für Varianten mit '<'/'>' muss Exchange/Graph den Anzeigenamen mit diesen Zeichen in emailAddress.name liefern (nicht lokal beobachtet). Die Variante '{{unsubscribe}}' über eine Textzeile im Mailbody hängt davon nicht ab.; Wie Markup/Kommentare beim Empfänger dargestellt werden, hängt vom Mail-Client ab; nachgewiesen ist das Vorhandensein des rohen Markups bzw. das Fehlen des Footers im versendeten MIME-Teil.

**Fix.** Kontextabhängiges Rendern einführen: für bodyHtml alle Platzhalterwerte HTML-escapen (renderHtml), Betreff/bodyText weiter als Klartext. ensureUnsubscribeFooter nur an der tatsächlich eingesetzten Abmelde-URL festmachen (Regex auf '{{unsubscribe}}' im gerenderten Text entfernen). Worker und preview-html auf renderHtml umstellen. Defense-in-depth im Verteiler: Namen aus Postfach-Import auf Zeichen wie <>{} prüfen/verwerfen. Regressionstest src/lib/templates.test.ts ergänzen.

**Vorgeschlagene Code-Änderung (Audit-Vorschlag; umgesetzte Fassung siehe Commit)**

`src/lib/templates.ts`

```
// src/lib/templates.ts (Auszug, geaendert)
const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(v: string): string {
  return v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

/** Ersetzt {{key}} bzw. {{ key }} durch den Wert. Unbekannte Keys -> leer.
 *  mode "html": Werte werden HTML-escaped (Kontaktdaten sind nicht vertrauenswuerdig). */
export function fillPlaceholders(
  template: string,
  vars: Record<string, string>,
  mode: "text" | "html" = "text"
): string {
  const out = mode === "html" ? escapeHtml : (s: string) => s;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_all, key: string) => {
    const direct = vars[key];
    if (direct !== undefined) return out(direct);
    if (key === "unsubscribe") return out(vars.unsubscribeUrl ?? "");
    if (key === "vorname") return out(vars.firstName ?? "");
    if (key === "nachname") return out(vars.lastName ?? "");
    if (key === "firma") return out(vars.company ?? "");
    return "";
  });
}

export function render(template: string, vars: Record<string, string>, rng: () => number): string {
  return fillPlaceholders(resolveSpintax(template, rng), vars, "text");
}

/** Fuer bodyHtml: Kontaktwerte escaped einsetzen. */
export function renderHtml(template: string, vars: Record<string, string>, rng: () => number): string {
  return fillPlaceholders(resolveSpintax(template, rng), vars, "html");
}

/** Entscheidung nur anhand der tatsaechlich eingesetzten Abmelde-URL; ein
 *  woertliches "{{unsubscribe}}" im gerenderten Text (z. B. aus Kontaktdaten)
 *  zaehlt nicht mehr als Abmeldelink. */
export function ensureUnsubscribeFooter(html: string, url: string): string {
  if (html.includes(escapeHtml(url))) return html;
  const safe = escapeHtml(url);
  return (
    html +
    `\n<hr style="border:0;border-top:1px solid #e2e8f0;margin:28px 0 12px" />` +
    `\n<p style="font-size:12px;color:#64748b;margin:0">` +
    `Sie möchten keine weiteren E-Mails erhalten? ` +
    `<a href="${safe}" style="color:#004c4d">Hier abmelden</a>.</p>`
  );
}
```

`src/lib/worker.ts`

```
// src/lib/worker.ts (Zeilen 211-213) und analog src/app/api/campaigns/preview-html/route.ts (Zeilen 70-73)
import { contactVars, ensureUnsubscribeFooter, render, renderHtml, unsubscribeUrl } from "./templates";
  const subject = render(campaign.subject, vars, rng);                                   // Klartext
  const html = ensureUnsubscribeFooter(renderHtml(campaign.bodyHtml, vars, rng), unsubUrl); // HTML-escaped
  const text = campaign.bodyText ? render(campaign.bodyText, vars, rng) : undefined;       // Klartext
```

`src/lib/templates.test.ts`

```
// src/lib/templates.test.ts  – Ausfuehren: FIELD_ENCRYPTION_KEY=<64 hex> npx tsx --test src/lib/templates.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtml, render, ensureUnsubscribeFooter } from "./templates";

const url = "https://mailing.example.test/abmelden?token=TOK";
const base = { email: "a@example.org", lastName: "", fullName: "", company: "", unsubscribeUrl: url };
const rng = () => 0;

test("Kontaktwerte werden im HTML-Body escaped", () => {
  const html = renderHtml("<p>Hallo {{firstName}}</p>", { ...base, firstName: "<b>x</b>" }, rng);
  assert.equal(html, "<p>Hallo &lt;b&gt;x&lt;/b&gt;</p>");
});

test("'<!--' im Namen versteckt den Abmelde-Footer nicht", () => {
  const html = ensureUnsubscribeFooter(renderHtml("<p>Hallo {{firstName}}</p>", { ...base, firstName: "Max <!--" }, rng), url);
  assert.ok(!html.includes("<!--"));
  assert.ok(html.includes(`href="${url}"`));
});

test("woertliches {{unsubscribe}} im Kontaktfeld unterdrueckt den Footer nicht", () => {
  const html = ensureUnsubscribeFooter(renderHtml("<p>Hallo {{firstName}}</p>", { ...base, firstName: "{{unsubscribe}}" }, rng), url);
  assert.ok(html.includes(`href="${url}"`));
});

test("Vorlage mit eigenem {{unsubscribe}}-Link bekommt keinen zweiten Footer", () => {
  const html = ensureUnsubscribeFooter(renderHtml('<a href="{{unsubscribe}}">ab</a>', { ...base, firstName: "" }, rng), url);
  assert.equal(html, `<a href="${url}">ab</a>`);
});

test("Betreff/Text bleiben unescaped (Klartext)", () => {
  assert.equal(render("Hallo {{firstName}}", { ...base, firstName: "A & B" }, rng), "Hallo A & B");
});
```
