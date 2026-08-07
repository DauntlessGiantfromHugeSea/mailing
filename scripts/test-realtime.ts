// Echtzeit-Test: legt eine Kampagne an, die JETZT startet, und prüft
// anschließend, ob die Mails tatsächlich zeitlich verteilt angekommen sind.
//
// Ablauf:
//   1. `npx tsx --env-file-if-exists=.env scripts/test-realtime.ts setup`
//   2. `npm run worker` laufen lassen (einige Minuten)
//   3. `npx tsx --env-file-if-exists=.env scripts/test-realtime.ts verify`
//
// Das ist der Test, der beweist, dass nicht alles auf einmal rausgeht.

import fs from "node:fs";
import { prisma } from "../src/lib/db";
import { encryptField } from "../src/lib/crypto";
import { upsertContacts } from "../src/lib/contacts";
import { launchCampaign } from "../src/lib/campaigns";

const SINK_LOG = process.env.SINK_LOG ?? "/tmp/sink.jsonl";
const COUNT = Number(process.env.COUNT ?? 5);

async function setup(): Promise<void> {
  await prisma.sendJob.deleteMany();
  await prisma.campaignSender.deleteMany();
  await prisma.campaign.deleteMany();
  await prisma.listMembership.deleteMany();
  await prisma.contactList.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.suppression.deleteMany();
  await prisma.sender.deleteMany();
  await prisma.workerLock.deleteMany();
  fs.writeFileSync(SINK_LOG, "");

  await prisma.sender.create({
    data: {
      label: "rt", email: "rt@test.local", fromName: "Realtime",
      smtpHost: "127.0.0.1", smtpPort: 2525, smtpSecure: false,
      smtpUser: "rt@test.local", smtpPassEnc: encryptField("pw")!,
      dailyLimit: 100, warmupEnabled: false,
    },
  });

  const list = await prisma.contactList.create({ data: { name: "Echtzeit" } });
  await upsertContacts(
    Array.from({ length: COUNT }, (_, i) => ({
      email: `rt${i + 1}@example.org`, firstName: `RT${i + 1}`, source: "test",
    })),
    { listId: list.id }
  );

  const campaign = await prisma.campaign.create({
    data: {
      name: "Echtzeit-Takt",
      subject: "Takt-Test {{firstName}}",
      bodyHtml: "<p>Hallo {{firstName}}</p>",
      listId: list.id,
      intervalMinutes: 1,
      jitterPercent: 70,
      shuffleRecipients: true,
      timezone: "Europe/Berlin",
      sendDays: JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
      windowStartMinute: 0,
      windowEndMinute: 1439,
      startAt: new Date(),
    },
  });

  const res = await launchCampaign(campaign.id, new Date());
  const jobs = await prisma.sendJob.findMany({
    where: { campaignId: campaign.id }, orderBy: { scheduledAt: "asc" },
  });

  console.log(`Kampagne gestartet: ${res.recipientCount} Mails eingeplant.`);
  console.log("Geplante Zeitpunkte (soll):");
  const t0 = jobs[0].scheduledAt.getTime();
  jobs.forEach((j, i) => {
    const prev = i > 0 ? jobs[i - 1].scheduledAt.getTime() : null;
    console.log(
      `  #${i + 1} ${j.scheduledAt.toISOString()}  +${Math.round((j.scheduledAt.getTime() - t0) / 1000)}s` +
        (prev ? `  (Abstand ${Math.round((j.scheduledAt.getTime() - prev) / 1000)}s)` : "")
    );
  });
  console.log(`\nLetzte Mail geplant für: ${jobs[jobs.length - 1].scheduledAt.toISOString()}`);
}

async function verify(): Promise<void> {
  const entries = fs
    .readFileSync(SINK_LOG, "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as { at: string; to: string[]; subject: string });

  console.log(`\n=== Tatsächlich beim SMTP-Server angekommen: ${entries.length} ===`);

  let failures = 0;
  const check = (name: string, ok: boolean, detail = "") => {
    console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) failures++;
  };

  const times = entries.map((e) => new Date(e.at).getTime());
  const gaps = times.slice(1).map((t, i) => Math.round((t - times[i]) / 1000));

  entries.forEach((e, i) => {
    console.log(
      `  #${i + 1} ${e.at}  ${e.to.join(",")}` + (i > 0 ? `   Abstand ${gaps[i - 1]}s` : "")
    );
  });

  check("mehrere Mails zugestellt", entries.length >= 3, `${entries.length}`);

  if (gaps.length > 0) {
    const spanSec = Math.round((times[times.length - 1] - times[0]) / 1000);
    check("Mails NICHT alle gleichzeitig", gaps.every((g) => g >= 15),
      `kleinster Abstand ${Math.min(...gaps)}s`);
    check("Versand über mehrere Minuten gestreckt", spanSec >= 60,
      `${spanSec}s zwischen erster und letzter Mail`);
    check("Abstände unterschiedlich (randomisiert)", new Set(gaps).size > 1,
      `Abstände: ${gaps.join("s, ")}s`);

    // Soll/Ist-Abgleich: der Worker darf nicht deutlich zu früh senden.
    const jobs = await prisma.sendJob.findMany({
      where: { status: "SENT" }, orderBy: { sentAt: "asc" },
      select: { scheduledAt: true, sentAt: true },
    });
    const lateness = jobs
      .filter((j) => j.sentAt)
      .map((j) => Math.round((j.sentAt!.getTime() - j.scheduledAt.getTime()) / 1000));
    check("keine Mail vor ihrem geplanten Zeitpunkt", lateness.every((l) => l >= -2),
      `Abweichungen: ${lateness.join("s, ")}s`);
    check("Verspätung bleibt klein (< 30 s)", lateness.every((l) => l < 30),
      `max ${Math.max(...lateness)}s`);
  }

  const remaining = await prisma.sendJob.count({ where: { status: "PENDING" } });
  console.log(`\n  noch offen: ${remaining}`);
  console.log(failures === 0 ? "\n✅ Echtzeit-Takt bestätigt.\n" : `\n❌ ${failures} Test(s) fehlgeschlagen.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

const mode = process.argv[2];
(mode === "verify" ? verify() : setup())
  .then(() => prisma.$disconnect())
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
