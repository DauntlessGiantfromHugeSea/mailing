import { prisma } from "./db";
import { safeDecrypt } from "./crypto";
import { sendViaSender } from "./mailer";
import { pickSender, sendersForCampaign } from "./senders";
import { contactVars, ensureUnsubscribeFooter, render, unsubscribeUrl } from "./templates";
import { makeRng } from "./random";
import { isInWindow, windowFrom } from "./sendWindow";
import type { Campaign, SendJob } from "@prisma/client";

// Der Tick: holt faellige Jobs und versendet sie EINZELN, nacheinander.
//
// Warum einzeln und nicht parallel? Weil der Zeitplan die Randomisierung
// traegt. Wuerden mehrere Jobs gleichzeitig laufen, gingen mehrere Mails in
// derselben Sekunde raus und der Minutentakt waere hin. Ein Tick sendet
// hoechstens `maxPerTick` Mails - normalerweise genau eine, weil bei einem
// Abstand von Minuten selten mehr als ein Job faellig ist. Der Rest existiert
// nur, um nach einem Worker-Ausfall den Rueckstand abzuarbeiten.

const LOCK_ID = "sendjob-worker";
const LOCK_TTL_MS = 60_000;
/** Ein Job, der so lange in SENDING haengt, gilt als verwaist. */
const STALE_SENDING_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;

export interface TickResult {
  claimed: boolean;
  processed: number;
  sent: number;
  failed: number;
  skipped: number;
  deferred: number;
  notes: string[];
}

const emptyTick = (notes: string[] = []): TickResult => ({
  claimed: false,
  processed: 0,
  sent: 0,
  failed: 0,
  skipped: 0,
  deferred: 0,
  notes,
});

/**
 * Kooperatives Lock ueber eine DB-Zeile. Verhindert, dass zwei Instanzen
 * (Worker-Prozess + Cron-Endpunkt) gleichzeitig senden.
 */
async function acquireLock(holder: string): Promise<boolean> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + LOCK_TTL_MS);
  try {
    await prisma.workerLock.create({ data: { id: LOCK_ID, holder, expiresAt } });
    return true;
  } catch {
    // Zeile existiert - uebernehmen, falls abgelaufen.
    const res = await prisma.workerLock.updateMany({
      where: { id: LOCK_ID, expiresAt: { lt: now } },
      data: { holder, acquiredAt: now, expiresAt },
    });
    return res.count > 0;
  }
}

async function releaseLock(holder: string): Promise<void> {
  await prisma.workerLock.deleteMany({ where: { id: LOCK_ID, holder } });
}

/** Jobs zurueckholen, deren Bearbeitung abgebrochen ist (Crash mitten im Send). */
async function requeueStale(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_SENDING_MS);
  const res = await prisma.sendJob.updateMany({
    where: { status: "SENDING", lockedAt: { lt: cutoff } },
    data: { status: "PENDING", lockedAt: null },
  });
  return res.count;
}

export async function tick(opts: { maxPerTick?: number; holder?: string } = {}): Promise<TickResult> {
  const maxPerTick = opts.maxPerTick ?? 5;
  const holder = opts.holder ?? `pid-${process.pid}`;

  if (!(await acquireLock(holder))) {
    return emptyTick(["Ein anderer Worker hält gerade das Lock - Tick übersprungen."]);
  }

  const result: TickResult = { ...emptyTick(), claimed: true };
  try {
    const requeued = await requeueStale();
    if (requeued > 0) result.notes.push(`${requeued} hängende Job(s) zurückgestellt.`);

    // Kampagnen, die durch das Erreichen von startAt faellig geworden sind,
    // von SCHEDULED auf RUNNING heben.
    await prisma.campaign.updateMany({
      where: { status: "SCHEDULED", startAt: { lte: new Date() } },
      data: { status: "RUNNING", startedAt: new Date() },
    });

    for (let i = 0; i < maxPerTick; i++) {
      const outcome = await processNextDueJob(result);
      if (outcome === "none") break;
      if (outcome === "blocked") break;
    }

    await finishCompletedCampaigns();
  } finally {
    await releaseLock(holder);
  }
  return result;
}

type Outcome = "sent" | "failed" | "skipped" | "deferred" | "none" | "blocked";

async function processNextDueJob(result: TickResult): Promise<Outcome> {
  const now = new Date();

  const job = await prisma.sendJob.findFirst({
    where: {
      status: "PENDING",
      scheduledAt: { lte: now },
      campaign: { status: "RUNNING" },
    },
    orderBy: { scheduledAt: "asc" },
    include: { campaign: true, contact: true },
  });
  if (!job) return "none";

  // Optimistisch beanspruchen: nur wenn der Job noch PENDING ist.
  const claim = await prisma.sendJob.updateMany({
    where: { id: job.id, status: "PENDING" },
    data: { status: "SENDING", lockedAt: now, attempts: { increment: 1 } },
  });
  if (claim.count === 0) return "deferred";

  result.processed++;

  const campaign = job.campaign;
  const contact = job.contact;

  // --- Sendefenster erneut prueffen. Es kann sich seit dem Planen geaendert
  //     haben; dann wird der Job auf das naechste Fenster verschoben statt
  //     ausserhalb der Bueroezeit gesendet.
  const window = windowFrom(campaign);
  if (!isInWindow(now, window)) {
    const { nextWindowOpening } = await import("./sendWindow");
    await prisma.sendJob.update({
      where: { id: job.id },
      data: {
        status: "PENDING",
        lockedAt: null,
        attempts: { decrement: 1 },
        scheduledAt: nextWindowOpening(now, window),
      },
    });
    result.deferred++;
    result.notes.push("Außerhalb des Sendefensters - auf nächstes Fenster verschoben.");
    return "blocked";
  }

  // --- Empfaenger noch zustellbar?
  const suppressed = await prisma.suppression.findUnique({
    where: { emailHash: contact.emailHash },
  });
  if (contact.status !== "ACTIVE" || suppressed) {
    await prisma.sendJob.update({
      where: { id: job.id },
      data: {
        status: "SKIPPED",
        lockedAt: null,
        error: suppressed ? `Sperrliste: ${suppressed.reason}` : `Kontaktstatus ${contact.status}`,
      },
    });
    await bumpCampaign(campaign.id, { skipped: 1 });
    result.skipped++;
    return "skipped";
  }

  const email = safeDecrypt(contact.email);
  if (!email) {
    await failJob(job, "E-Mail-Adresse nicht entschlüsselbar", false, result);
    return "failed";
  }

  // --- Absender waehlen (Rotation + Tageslimit/Warmup)
  const candidates = await sendersForCampaign(campaign.id);
  const sender = await pickSender(candidates, now);
  if (!sender) {
    // Kein Fehler: alle Postfaecher sind fuer heute am Limit. Job auf den
    // naechsten Fensterbeginn morgen schieben.
    const { nextWindowOpening } = await import("./sendWindow");
    const tomorrow = new Date(now.getTime() + 8 * 60 * 60_000);
    await prisma.sendJob.update({
      where: { id: job.id },
      data: {
        status: "PENDING",
        lockedAt: null,
        attempts: { decrement: 1 },
        scheduledAt: nextWindowOpening(tomorrow, window),
      },
    });
    result.deferred++;
    result.notes.push("Tageslimit aller Absender erreicht - Rest auf morgen verschoben.");
    return "blocked";
  }

  // --- Mail rendern. RNG pro Job, damit Spintax stabil, aber je Empfaenger
  //     unterschiedlich ist.
  const rng = makeRng(`${campaign.randomSeed ?? campaign.id}:${contact.id}`);
  const vars = contactVars(contact);
  const unsubUrl = unsubscribeUrl(contact.unsubscribeToken);
  const subject = render(campaign.subject, vars, rng);
  const html = ensureUnsubscribeFooter(render(campaign.bodyHtml, vars, rng), unsubUrl);
  const text = campaign.bodyText ? render(campaign.bodyText, vars, rng) : undefined;

  const res = await sendViaSender(sender, {
    to: email,
    subject,
    html,
    text,
    listUnsubscribeUrl: unsubUrl,
  });

  if (res.ok) {
    await prisma.sendJob.update({
      where: { id: job.id },
      data: {
        status: "SENT",
        senderId: sender.id,
        sentAt: new Date(),
        messageId: res.messageId ?? null,
        error: null,
        lockedAt: null,
      },
    });
    // Warmup-Uhr beim ersten echten Versand starten.
    if (sender.warmupEnabled && !sender.warmupStartedAt) {
      await prisma.sender.update({
        where: { id: sender.id },
        data: { warmupStartedAt: new Date() },
      });
    }
    await bumpCampaign(campaign.id, { sent: 1 });
    result.sent++;
    return "sent";
  }

  await failJob({ ...job, senderId: sender.id }, res.error ?? "Unbekannter SMTP-Fehler", res.retryable ?? false, result);
  return "failed";
}

async function failJob(
  job: SendJob & { campaign: Campaign },
  error: string,
  retryable: boolean,
  result: TickResult
): Promise<void> {
  const canRetry = retryable && job.attempts < MAX_ATTEMPTS;
  if (canRetry) {
    // Exponentieller Backoff, damit ein kurzzeitiges Serverproblem den Takt
    // nicht durchbricht.
    const delayMin = Math.pow(2, job.attempts) * 5;
    await prisma.sendJob.update({
      where: { id: job.id },
      data: {
        status: "PENDING",
        lockedAt: null,
        error,
        senderId: job.senderId,
        scheduledAt: new Date(Date.now() + delayMin * 60_000),
      },
    });
    result.deferred++;
    result.notes.push(`Temporärer Fehler, neuer Versuch in ${delayMin} min: ${error}`);
    return;
  }

  await prisma.sendJob.update({
    where: { id: job.id },
    data: { status: "FAILED", lockedAt: null, error, senderId: job.senderId },
  });
  await bumpCampaign(job.campaignId, { failed: 1 });
  result.failed++;
}

async function bumpCampaign(
  campaignId: string,
  delta: { sent?: number; failed?: number; skipped?: number }
): Promise<void> {
  await prisma.campaign.update({
    where: { id: campaignId },
    data: {
      ...(delta.sent ? { sentCount: { increment: delta.sent } } : {}),
      ...(delta.failed ? { failedCount: { increment: delta.failed } } : {}),
      ...(delta.skipped ? { skippedCount: { increment: delta.skipped } } : {}),
    },
  });
}

/** Kampagnen ohne offene Jobs auf COMPLETED setzen. */
async function finishCompletedCampaigns(): Promise<void> {
  const running = await prisma.campaign.findMany({
    where: { status: { in: ["RUNNING", "SCHEDULED"] } },
    select: { id: true },
  });
  for (const c of running) {
    const open = await prisma.sendJob.count({
      where: { campaignId: c.id, status: { in: ["PENDING", "SENDING"] } },
    });
    if (open === 0) {
      const total = await prisma.sendJob.count({ where: { campaignId: c.id } });
      if (total > 0) {
        await prisma.campaign.update({
          where: { id: c.id },
          data: { status: "COMPLETED", finishedAt: new Date() },
        });
      }
    }
  }
}

/** Wann ist der naechste Job faellig? Fuer die Anzeige und die Tick-Pausen. */
export async function nextDueAt(): Promise<Date | null> {
  const job = await prisma.sendJob.findFirst({
    where: { status: "PENDING", campaign: { status: "RUNNING" } },
    orderBy: { scheduledAt: "asc" },
    select: { scheduledAt: true },
  });
  return job?.scheduledAt ?? null;
}
