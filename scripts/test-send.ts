// End-to-End-Test des Versandpfads gegen eine echte DB und einen echten
// SMTP-Server (Test-Sink auf 127.0.0.1:2525).
//
// Geprüft werden:
//   - Jobs werden mit individuellen Sendezeitpunkten angelegt
//   - der Worker sendet tatsächlich per SMTP, einzeln, nacheinander
//   - Absender-Rotation über mehrere Postfächer
//   - Tageslimit stoppt den Versand statt Fehler zu produzieren
//   - Abmeldung zieht geplante Mails zurück
//   - Platzhalter und Spintax werden gerendert, Abmeldelink liegt an
//
// Aufruf:  npx tsx --env-file-if-exists=.env scripts/test-send.ts

import { prisma } from "../src/lib/db";
import { encryptField, safeDecrypt } from "../src/lib/crypto";
import { upsertContacts, unsubscribeByToken } from "../src/lib/contacts";
import { launchCampaign, campaignProgress } from "../src/lib/campaigns";
import { tick } from "../src/lib/worker";
import { loadSenderStats, pickSender, effectiveDailyLimit } from "../src/lib/senders";
import fs from "node:fs";

const SINK_LOG = process.env.SINK_LOG ?? "/tmp/sink.jsonl";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function sinkEntries(): { to: string[]; subject: string; hasUnsubHeader: boolean; from: string; at: string }[] {
  if (!fs.existsSync(SINK_LOG)) return [];
  return fs
    .readFileSync(SINK_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function reset(): Promise<void> {
  // Reihenfolge wegen der Fremdschlüssel.
  await prisma.sendJob.deleteMany();
  await prisma.campaignSender.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.listMembership.deleteMany();
  await prisma.contactList.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.suppression.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.workerLock.deleteMany();
  if (fs.existsSync(SINK_LOG)) fs.writeFileSync(SINK_LOG, "");
}

async function main(): Promise<void> {
  await reset();

  // ---------------------------------------------------------------- Absender
  console.log("\n=== Aufbau: 2 Absender, 8 Kontakte ===");

  const senderA = await prisma.sender.create({
    data: {
      label: "postfach-a", email: "a@test.local", fromName: "Test A",
      smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecure: false,
      smtpUser: "a@test.local", smtpPassEnc: encryptField("pw")!,
      dailyLimit: 5, warmupEnabled: false,
    },
  });
  const senderB = await prisma.sender.create({
    data: {
      label: "postfach-b", email: "b@test.local", fromName: "Test B",
      smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecure: false,
      smtpUser: "b@test.local", smtpPassEnc: encryptField("pw")!,
      dailyLimit: 5, warmupEnabled: false,
    },
  });

  const list = await prisma.contactList.create({ data: { name: "Testliste" } });
  const stats0 = await upsertContacts(
    Array.from({ length: 8 }, (_, i) => ({
      email: `empf${i + 1}@example.org`,
      firstName: `Vorname${i + 1}`,
      company: `Firma ${i + 1}`,
      source: "test",
    })),
    { listId: list.id }
  );
  check("8 Kontakte angelegt", stats0.created === 8, `${stats0.created} neu`);

  // ------------------------------------------------------------- Einplanung
  console.log("\n=== Einplanung ===");

  // startAt in der Vergangenheit: alle Jobs sind sofort fällig, damit der Test
  // nicht real 20 Minuten warten muss. Die Taktung selbst ist in
  // scripts/test-schedule.ts geprüft.
  const past = new Date(Date.now() - 6 * 3_600_000);

  const campaign = await prisma.campaign.create({
    data: {
      name: "E2E-Test",
      subject: "{Hallo|Guten Tag} {{firstName}} von {{company}}",
      bodyHtml: "<p>{Hallo|Servus} {{firstName}}, dies ist ein Test an {{email}}.</p>",
      listId: list.id,
      intervalMinutes: 1,
      jitterPercent: 50,
      shuffleRecipients: true,
      timezone: "Europe/Berlin",
      sendDays: JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
      windowStartMinute: 0,
      windowEndMinute: 1439, // ganztägig, damit der Test unabhängig von der Uhrzeit läuft
      startAt: past,
    },
  });

  const planned = await launchCampaign(campaign.id, past);
  check("8 Jobs eingeplant", planned.recipientCount === 8, `${planned.recipientCount}`);

  const jobs = await prisma.sendJob.findMany({
    where: { campaignId: campaign.id },
    orderBy: { scheduledAt: "asc" },
  });
  const distinctTimes = new Set(jobs.map((j) => j.scheduledAt.getTime())).size;
  check("jeder Job hat eigenen Zeitpunkt", distinctTimes === 8, `${distinctTimes} verschiedene Zeitpunkte`);
  check("Sequenznummern 0..7 vollständig", new Set(jobs.map((j) => j.sequence)).size === 8);

  // ------------------------------------------- Abmeldung zieht Job zurück
  console.log("\n=== Abmeldung vor dem Versand ===");
  const victim = await prisma.contact.findFirst({ where: { emailHash: { not: "" } }, orderBy: { createdAt: "asc" } });
  const unsub = await unsubscribeByToken(victim!.unsubscribeToken);
  check("Kontakt abgemeldet", unsub?.status === "UNSUBSCRIBED");

  const skipped = await prisma.sendJob.count({ where: { campaignId: campaign.id, status: "SKIPPED" } });
  check("geplante Mail wurde zurückgezogen", skipped === 1, `${skipped} übersprungen`);
  const supp = await prisma.suppression.count();
  check("Adresse steht auf der Sperrliste", supp === 1);

  // -------------------------------------------------------------- Versand
  console.log("\n=== Versand über den Worker ===");

  let totalSent = 0;
  const tickLog: string[] = [];
  for (let round = 1; round <= 6; round++) {
    const res = await tick({ maxPerTick: 3, holder: `test-${round}` });
    totalSent += res.sent;
    tickLog.push(`Runde ${round}: gesendet=${res.sent} verschoben=${res.deferred} fehler=${res.failed}`);
    if (res.notes.length) tickLog.push(`   ${res.notes.join(" | ")}`);
    if (res.sent === 0 && res.deferred === 0) break;
  }
  tickLog.forEach((l) => console.log(`        ${l}`));

  const mails = sinkEntries();
  check("Mails sind wirklich per SMTP angekommen", mails.length === 7, `${mails.length} im SMTP-Sink`);
  check("Worker-Zähler stimmt mit SMTP überein", totalSent === mails.length, `Worker=${totalSent} SMTP=${mails.length}`);

  const progress = await campaignProgress(campaign.id);
  check("DB-Status: 7 gesendet", progress.sent === 7, `sent=${progress.sent} failed=${progress.failed} skipped=${progress.skipped}`);
  check("keine Fehler", progress.failed === 0);
  // Echte Prüfung: die abgemeldete Adresse darf in keinem SMTP-Envelope stehen.
  const victimEmail = safeDecrypt(victim!.email)!;
  const allRecipients = mails.flatMap((m) => m.to);
  check("abgemeldeter Empfänger nicht angeschrieben",
    !allRecipients.includes(victimEmail),
    `${victimEmail} nicht unter ${allRecipients.length} Empfängern`);
  check("alle 7 übrigen Empfänger genau einmal angeschrieben",
    new Set(allRecipients).size === 7 && allRecipients.length === 7,
    `${allRecipients.length} Zustellungen an ${new Set(allRecipients).size} Adressen`);

  // --------------------------------------------------- Rendering-Kontrolle
  console.log("\n=== Inhalt der versendeten Mails ===");
  const subjects = mails.map((m) => m.subject);
  check("Platzhalter {{firstName}} ersetzt",
    subjects.every((s) => /Vorname\d/.test(s)) && !subjects.some((s) => s.includes("{{")),
    subjects[0]);
  check("Spintax aufgelöst (keine {a|b} mehr im Betreff)",
    !subjects.some((s) => /\{[^}]*\|/.test(s)));

  const greetings = new Set(subjects.map((s) => s.split(" ")[0]));
  check("Spintax erzeugt verschiedene Varianten", greetings.size > 1, `Varianten: ${[...greetings].join(", ")}`);
  check("List-Unsubscribe-Header gesetzt", mails.every((m) => m.hasUnsubHeader));

  const froms = new Set(mails.map((m) => m.from));
  check("Absender-Rotation aktiv (beide Postfächer benutzt)", froms.size === 2, `${[...froms].join(", ")}`);

  const perSender = await prisma.sendJob.groupBy({
    by: ["senderId"], where: { campaignId: campaign.id, status: "SENT" }, _count: { _all: true },
  });
  check("Last gleichmäßig verteilt",
    perSender.every((p) => p._count._all >= 3),
    perSender.map((p) => `${p.senderId === senderA.id ? "A" : "B"}=${p._count._all}`).join(" "));

  // ------------------------------------------------------ Tageslimit greift
  console.log("\n=== Tageslimit ===");
  const stats = await loadSenderStats([senderA, senderB]);
  check("Zähler kennt die heute gesendeten Mails",
    stats.reduce((s, x) => s + x.sentToday, 0) === 7,
    stats.map((x) => `${x.sender.label}=${x.sentToday}/${x.limit}`).join(" "));

  // Beide Absender auf ihr Limit setzen -> pickSender muss null liefern.
  await prisma.sender.updateMany({ where: {}, data: { dailyLimit: 3 } });
  const exhausted = await prisma.sender.findMany();
  const picked = await pickSender(exhausted);
  check("bei erreichtem Tageslimit wird kein Absender gewählt", picked === null,
    picked ? `unerwartet: ${picked.label}` : "null (Rest wird verschoben, nicht als Fehler markiert)");

  // Kampagne muss trotzdem als abgeschlossen gelten (alle Jobs erledigt).
  const finished = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  check("Kampagne abgeschlossen", finished?.status === "COMPLETED", finished?.status);

  // ---------------------------------------------------------- Warmup-Rampe
  console.log("\n=== Warmup-Rampe ===");
  const warm = await prisma.sender.create({
    data: {
      label: "warmup", email: "w@test.local", fromName: "W",
      smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecure: false,
      smtpUser: "w@test.local", smtpPassEnc: encryptField("pw")!,
      dailyLimit: 100, warmupEnabled: true, warmupStart: 10, warmupStep: 5,
      warmupStartedAt: new Date(Date.now() - 4 * 86_400_000), // Tag 5
    },
  });
  check("Warmup Tag 5 ergibt Limit 30", effectiveDailyLimit(warm) === 30, `${effectiveDailyLimit(warm)}`);

  const fresh = await prisma.sender.create({
    data: {
      label: "warmup-neu", email: "w2@test.local", fromName: "W2",
      smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecure: false,
      smtpUser: "w2@test.local", smtpPassEnc: encryptField("pw")!,
      dailyLimit: 100, warmupEnabled: true, warmupStart: 10, warmupStep: 5,
    },
  });
  check("neues Postfach startet bei 10", effectiveDailyLimit(fresh) === 10, `${effectiveDailyLimit(fresh)}`);

  const capped = await prisma.sender.create({
    data: {
      label: "warmup-gedeckelt", email: "w3@test.local", fromName: "W3",
      smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecure: false,
      smtpUser: "w3@test.local", smtpPassEnc: encryptField("pw")!,
      dailyLimit: 25, warmupEnabled: true, warmupStart: 10, warmupStep: 5,
      warmupStartedAt: new Date(Date.now() - 60 * 86_400_000),
    },
  });
  check("Warmup überschreitet dailyLimit nicht", effectiveDailyLimit(capped) === 25, `${effectiveDailyLimit(capped)}`);

  console.log(
    failures === 0 ? "\n✅ Alle Versand-Tests bestanden.\n" : `\n❌ ${failures} Test(s) fehlgeschlagen.\n`
  );
  await prisma.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("Testlauf abgebrochen:", e);
  await prisma.$disconnect();
  process.exit(1);
});
