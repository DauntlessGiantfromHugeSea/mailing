// Test der Verteiler-Schnittstelle gegen eine echte DB.
//
// Geprüft werden:
//   - ohne/falsches Token: 401, ohne VERTEILER_SYNC_TOKEN: 503
//   - Sperren aus dem Verteiler landen auf der Sperrliste, Kontakte werden
//     gesperrt, geplante Sendungen an sie abgebrochen
//   - die Liste wird exakt auf den Stand des Verteilers gebracht
//     (neu, aktualisiert, entfernt; gesperrte Adressen kommen nicht hinein)
//   - Abmeldungen/Bounces aus dem Mailing-Tool kommen als Rückmeldung zurück,
//     eigene Sperren des Verteilers nicht
//   - Wiederholung ist idempotent
//
// Aufruf:  VERTEILER_SYNC_TOKEN=... npx tsx --env-file-if-exists=.env scripts/test-verteiler-sync.ts
// ACHTUNG: leert die Tabellen der angegebenen Datenbank - nur gegen eine Test-DB laufen lassen.

import { prisma } from "../src/lib/db";
import { blindIndex, encryptField, safeDecrypt } from "../src/lib/crypto";
import { upsertContacts, unsubscribeByToken } from "../src/lib/contacts";
import { POST } from "../src/app/api/integration/verteiler/route";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const TOKEN = process.env.VERTEILER_SYNC_TOKEN ?? "";

async function call(body: unknown, token = TOKEN): Promise<{ status: number; json: any }> {
  const res = await POST(
    new Request("http://localhost/api/integration/verteiler", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, json: await res.json() };
}

async function reset(): Promise<void> {
  await prisma.sendJob.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.listMembership.deleteMany();
  await prisma.contactList.deleteMany();
  await prisma.retiredUnsubscribeToken.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.suppression.deleteMany();
  await prisma.auditLog.deleteMany();
}

async function contactBy(email: string) {
  return prisma.contact.findUnique({ where: { emailHash: blindIndex(email) } });
}

async function main(): Promise<void> {
  if (TOKEN.length < 32) throw new Error("VERTEILER_SYNC_TOKEN (min. 32 Zeichen) setzen");
  await reset();

  // --- Ausgangslage im Mailing-Tool
  await upsertContacts([
    { email: "alt@kunde.example.com", firstName: "Alt", source: "csv" },
    { email: "abgemeldet@kunde.example.com", firstName: "Abgemeldet", source: "csv" },
    { email: "spaeter-gesperrt@kunde.example.com", firstName: "Später", source: "csv" },
  ]);
  const ab = await contactBy("abgemeldet@kunde.example.com");
  await unsubscribeByToken(ab!.unsubscribeToken); // klickt Abmeldelink
  // Geplante Sendung an einen Kontakt, den der Verteiler gleich sperrt
  const sender = await prisma.sender.create({
    data: { label: "T", fromName: "T", email: "t@fb.example.com", smtpUser: "t", smtpPassEnc: encryptField("x")! },
  });
  const camp = await prisma.campaign.create({ data: { name: "K", subject: "S", bodyHtml: "<p>x</p>", status: "RUNNING" } });
  const sp = await contactBy("spaeter-gesperrt@kunde.example.com");
  await prisma.sendJob.create({
    data: { campaignId: camp.id, contactId: sp!.id, senderId: sender.id, scheduledAt: new Date(), sequence: 1 },
  });

  // --- Auth
  check("falsches Token -> 401", (await call({}, "x".repeat(40))).status === 401);
  const saved = process.env.VERTEILER_SYNC_TOKEN;
  delete process.env.VERTEILER_SYNC_TOKEN;
  check("ohne VERTEILER_SYNC_TOKEN -> 503", (await call({}, "egal")).status === 503);
  process.env.VERTEILER_SYNC_TOKEN = saved;
  check("ungültige Daten -> 400", (await call({ suppress: [{ email: "a@b.de", reason: "quatsch" }] })).status === 400);

  // --- Erster Abgleich
  const body = {
    suppress: [
      { email: "Spaeter-Gesperrt@kunde.example.com", reason: "bounce_hart" },
      { email: "nie-gesehen@kunde.example.com", reason: "abgemeldet" },
    ],
    list: {
      name: "Verteiler: Alle aktiven",
      contacts: [
        { email: "neu1@kunde.example.com", firstName: "Neu", lastName: "Eins", company: "ACME" },
        { email: "neu2@kunde.example.com", firstName: "Neu", lastName: "Zwei" },
        { email: "abgemeldet@kunde.example.com", firstName: "Abgemeldet" }, // hier abgemeldet!
      ],
    },
    check: ["neu1@kunde.example.com", "neu2@kunde.example.com", "abgemeldet@kunde.example.com"],
  };
  const r1 = await call(body);
  check("Abgleich -> 200", r1.status === 200, JSON.stringify(r1.json).slice(0, 200));
  check("2 Sperren übernommen", r1.json.suppressionsAdded === 2, String(r1.json.suppressionsAdded));
  check("1 Kontakt gesperrt", r1.json.contactsBlocked === 1, String(r1.json.contactsBlocked));
  check("geplante Sendung abgebrochen", r1.json.jobsSkipped === 1);
  const job = await prisma.sendJob.findFirst({ where: { contactId: sp!.id } });
  check("Job steht auf SKIPPED", job?.status === "SKIPPED");
  check("Kontaktstatus BOUNCED", (await contactBy("spaeter-gesperrt@kunde.example.com"))?.status === "BOUNCED");
  check("Liste: 2 Mitglieder (abgemeldete Adresse nicht)", r1.json.list.members === 2, JSON.stringify(r1.json.list));
  check("Liste: 2 neue Kontakte", r1.json.list.created === 2);
  const n1 = await contactBy("neu1@kunde.example.com");
  check("Kontakt verschlüsselt gespeichert", !!n1 && n1.email.startsWith("v1:") && safeDecrypt(n1.company) === "ACME");
  check(
    "Rückmeldung: Abmeldung aus dem Mailing-Tool",
    r1.json.suppressions.length === 1 &&
      r1.json.suppressions[0].email === "abgemeldet@kunde.example.com" &&
      r1.json.suppressions[0].grund === "abgemeldet",
    JSON.stringify(r1.json.suppressions)
  );

  // --- Zweiter Abgleich: neu2 fällt raus, neu3 kommt dazu; Sperren unverändert
  const r2 = await call({
    ...body,
    list: { name: "Verteiler: Alle aktiven", contacts: [{ email: "neu1@kunde.example.com" }, { email: "neu3@kunde.example.com" }] },
    check: ["neu1@kunde.example.com", "nie-gesehen@kunde.example.com"],
  });
  check("2. Abgleich: keine neuen Sperren (idempotent)", r2.json.suppressionsAdded === 0);
  check("2. Abgleich: 1 entfernt, 2 Mitglieder", r2.json.list.removed === 1 && r2.json.list.members === 2, JSON.stringify(r2.json.list));
  check("eigene Verteiler-Sperren kommen nicht zurück", r2.json.suppressions.length === 0, JSON.stringify(r2.json.suppressions));
  const lists = await prisma.contactList.count();
  check("Liste nicht doppelt angelegt", lists === 1);
  check("Audit-Eintrag geschrieben", (await prisma.auditLog.count({ where: { action: "verteiler.sync" } })) === 2);

  // --- Nur Sperren/Abfrage ohne Liste
  const r3 = await call({ check: ["abgemeldet@kunde.example.com"] });
  check("ohne Liste: Liste bleibt unberührt", r3.json.list === null && (await prisma.listMembership.count()) === 2);

  // Klartext der Adressen steht nicht in der Sperrliste
  const sup = await prisma.suppression.findMany();
  check("Sperrliste ohne Klartext", sup.every((s) => !s.emailHash.includes("@")) && sup.length === 3);

  // --- DSGVO-Löschung aus dem Verteiler
  const neu1 = await contactBy("neu1@kunde.example.com");
  const r4 = await call({
    erase: [
      { email: "neu1@kunde.example.com", keepSuppression: true },
      { email: "spaeter-gesperrt@kunde.example.com", keepSuppression: false },
      { email: "abgemeldet@kunde.example.com", keepSuppression: false },
    ],
    suppress: [{ email: "neu1@kunde.example.com", reason: "manuell" }],
  });
  check("erase -> 200", r4.status === 200, JSON.stringify(r4.json).slice(0, 200));
  check("erase: 3 Kontakte gelöscht", r4.json.erased?.contactsDeleted === 3, JSON.stringify(r4.json.erased));
  check("erase: Kontakt weg", (await contactBy("neu1@kunde.example.com")) === null);
  check("erase: Abmeldelink bleibt gültig",
    (await prisma.retiredUnsubscribeToken.count({ where: { token: neu1!.unsubscribeToken } })) === 1);
  check("erase: Verteiler-Sperre ohne keepSuppression entfernt",
    (await prisma.suppression.count({ where: { emailHash: blindIndex("spaeter-gesperrt@kunde.example.com") } })) === 0);
  check("erase: eigene Abmeldung des Mailing-Tools bleibt",
    (await prisma.suppression.count({ where: { emailHash: blindIndex("abgemeldet@kunde.example.com") } })) === 1);
  check("erase + Sperre: Sperre danach vorhanden",
    (await prisma.suppression.count({ where: { emailHash: blindIndex("neu1@kunde.example.com") } })) === 1);

  await reset();
  await prisma.$disconnect();
  console.log(failures ? `\n${failures} Fehler` : "\nAlle Prüfungen bestanden.");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
