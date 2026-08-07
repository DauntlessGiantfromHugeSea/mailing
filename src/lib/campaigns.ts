import { prisma } from "./db";
import { blindIndex, safeDecrypt } from "./crypto";
import { buildSchedule, pacingFrom, windowOf } from "./schedule";
import { newSeed } from "./random";
import { sendersForCampaign } from "./senders";
import type { Campaign, Contact } from "@prisma/client";

// Kampagnen-Lebenszyklus: Empfaenger bestimmen -> Zeitplan bauen -> Jobs
// anlegen -> starten / pausieren / fortsetzen / abbrechen.

export class CampaignError extends Error {}

/**
 * Empfaenger einer Kampagne: alle ACTIVE-Kontakte der Liste, gefiltert nach
 * Tags, abzueglich der globalen Sperrliste.
 */
export async function resolveRecipients(campaign: Campaign): Promise<Contact[]> {
  const base = campaign.listId
    ? await prisma.contact
        .findMany({
          where: { status: "ACTIVE", memberships: { some: { listId: campaign.listId } } },
          orderBy: { createdAt: "asc" },
        })
    : await prisma.contact.findMany({ where: { status: "ACTIVE" }, orderBy: { createdAt: "asc" } });

  const tagFilter: string[] = campaign.tagFilter ? safeJsonArray(campaign.tagFilter) : [];
  const tagged = tagFilter.length
    ? base.filter((c) => {
        const tags = c.tags ? safeJsonArray(c.tags) : [];
        return tagFilter.some((t) => tags.includes(t));
      })
    : base;

  // Sperrliste abziehen.
  const suppressed = new Set(
    (await prisma.suppression.findMany({ select: { emailHash: true } })).map((s) => s.emailHash)
  );
  return tagged.filter((c) => !suppressed.has(c.emailHash));
}

function safeJsonArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export interface PlanResult {
  recipientCount: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

/**
 * Legt fuer jeden Empfaenger einen SendJob mit individuellem `scheduledAt` an
 * und setzt die Kampagne auf SCHEDULED. Das ist der Moment, in dem die
 * Randomisierung festgeschrieben wird.
 *
 * Bereits vorhandene Jobs derselben Kampagne werden vorher entfernt (nur
 * PENDING - schon gesendete bleiben unangetastet), damit ein erneutes Planen
 * nach einer Aenderung sauber ist.
 */
export async function planCampaign(
  campaignId: string,
  opts: { startAt?: Date; reshuffle?: boolean } = {}
): Promise<PlanResult> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new CampaignError("Kampagne nicht gefunden");
  if (campaign.status === "RUNNING") {
    throw new CampaignError("Kampagne läuft bereits - bitte zuerst pausieren");
  }
  if (campaign.status === "COMPLETED") {
    throw new CampaignError("Kampagne ist abgeschlossen");
  }

  const senders = await sendersForCampaign(campaignId);
  if (senders.length === 0) {
    throw new CampaignError(
      "Kein aktiver Absender vorhanden. Bitte unter „Absender“ ein Postfach anlegen oder aus Hostinger importieren."
    );
  }

  const recipients = await resolveRecipients(campaign);
  if (recipients.length === 0) {
    throw new CampaignError("Keine passenden Empfänger gefunden (Liste leer, Tag-Filter zu eng oder alle abgemeldet).");
  }

  const seed = opts.reshuffle || !campaign.randomSeed ? newSeed() : campaign.randomSeed;
  const startAt = opts.startAt ?? campaign.startAt ?? new Date();
  const pacing = { ...pacingFrom(campaign), seed };
  const slots = buildSchedule(recipients, startAt, pacing, windowOf(campaign));

  await prisma.$transaction(async (tx) => {
    // Nur noch nicht versendete Jobs neu planen.
    await tx.sendJob.deleteMany({ where: { campaignId, status: { in: ["PENDING", "CANCELLED"] } } });

    const alreadyHandled = new Set(
      (
        await tx.sendJob.findMany({
          where: { campaignId },
          select: { contactId: true },
        })
      ).map((j) => j.contactId)
    );

    const toCreate = slots
      .filter((s) => !alreadyHandled.has(s.item.id))
      .map((s) => ({
        campaignId,
        contactId: s.item.id,
        scheduledAt: s.scheduledAt,
        sequence: s.sequence,
        status: "PENDING" as const,
      }));

    if (toCreate.length > 0) {
      await tx.sendJob.createMany({ data: toCreate, skipDuplicates: true });
    }

    await tx.campaign.update({
      where: { id: campaignId },
      data: {
        status: "SCHEDULED",
        randomSeed: seed,
        startAt,
        scheduledAt: new Date(),
        recipientCount: await tx.sendJob.count({ where: { campaignId } }),
      },
    });
  });

  return {
    recipientCount: slots.length,
    firstAt: slots[0]?.scheduledAt ?? null,
    lastAt: slots[slots.length - 1]?.scheduledAt ?? null,
  };
}

/** Plant (falls noetig) und schaltet die Kampagne auf RUNNING. */
export async function launchCampaign(campaignId: string, startAt?: Date): Promise<PlanResult> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new CampaignError("Kampagne nicht gefunden");

  const pending = await prisma.sendJob.count({ where: { campaignId, status: "PENDING" } });
  let result: PlanResult;
  if (pending === 0 || campaign.status === "DRAFT") {
    result = await planCampaign(campaignId, { startAt });
  } else {
    const agg = await prisma.sendJob.aggregate({
      where: { campaignId, status: "PENDING" },
      _min: { scheduledAt: true },
      _max: { scheduledAt: true },
    });
    result = {
      recipientCount: pending,
      firstAt: agg._min.scheduledAt ?? null,
      lastAt: agg._max.scheduledAt ?? null,
    };
  }

  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: "RUNNING", startedAt: campaign.startedAt ?? new Date() },
  });
  return result;
}

export async function pauseCampaign(campaignId: string): Promise<void> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new CampaignError("Kampagne nicht gefunden");
  if (campaign.status !== "RUNNING" && campaign.status !== "SCHEDULED") {
    throw new CampaignError("Nur laufende oder geplante Kampagnen können pausiert werden");
  }
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: "PAUSED" } });
}

/**
 * Setzt eine pausierte Kampagne fort. Termine, die waehrend der Pause verfallen
 * sind, werden um die Pausendauer nach hinten verschoben - so bleiben die
 * randomisierten Abstaende erhalten, statt dass alle verpassten Mails auf
 * einmal rausgehen.
 */
export async function resumeCampaign(campaignId: string): Promise<{ shifted: number }> {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new CampaignError("Kampagne nicht gefunden");
  if (campaign.status !== "PAUSED") throw new CampaignError("Kampagne ist nicht pausiert");

  const now = new Date();
  const overdue = await prisma.sendJob.findMany({
    where: { campaignId, status: "PENDING", scheduledAt: { lt: now } },
    orderBy: { scheduledAt: "asc" },
    select: { id: true, scheduledAt: true },
  });

  let shifted = 0;
  if (overdue.length > 0) {
    // Verschiebung = Abstand zwischen dem aeltesten verpassten Termin und jetzt.
    const offsetMs = now.getTime() - overdue[0].scheduledAt.getTime();
    const window = windowOf(campaign);
    const { addWorkSeconds } = await import("./sendWindow");

    await prisma.$transaction(
      overdue.map((job) =>
        prisma.sendJob.update({
          where: { id: job.id },
          data: {
            scheduledAt: addWorkSeconds(
              new Date(job.scheduledAt.getTime() + offsetMs),
              0,
              window
            ),
          },
        })
      )
    );
    shifted = overdue.length;
  }

  await prisma.campaign.update({ where: { id: campaignId }, data: { status: "RUNNING" } });
  return { shifted };
}

export async function cancelCampaign(campaignId: string): Promise<{ cancelled: number }> {
  const res = await prisma.sendJob.updateMany({
    where: { campaignId, status: "PENDING" },
    data: { status: "CANCELLED" },
  });
  await prisma.campaign.update({
    where: { id: campaignId },
    data: { status: "CANCELLED", finishedAt: new Date() },
  });
  return { cancelled: res.count };
}

export interface CampaignProgress {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
  sending: number;
  nextAt: Date | null;
  lastSentAt: Date | null;
  percent: number;
}

export async function campaignProgress(campaignId: string): Promise<CampaignProgress> {
  const grouped = await prisma.sendJob.groupBy({
    by: ["status"],
    where: { campaignId },
    _count: { _all: true },
  });
  const by = (s: string) => grouped.find((g) => g.status === s)?._count._all ?? 0;

  const [next, last] = await Promise.all([
    prisma.sendJob.findFirst({
      where: { campaignId, status: "PENDING" },
      orderBy: { scheduledAt: "asc" },
      select: { scheduledAt: true },
    }),
    prisma.sendJob.findFirst({
      where: { campaignId, status: "SENT" },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    }),
  ]);

  const total = grouped.reduce((sum, g) => sum + g._count._all, 0);
  const done = by("SENT") + by("FAILED") + by("SKIPPED") + by("CANCELLED");

  return {
    total,
    pending: by("PENDING"),
    sending: by("SENDING"),
    sent: by("SENT"),
    failed: by("FAILED"),
    skipped: by("SKIPPED"),
    cancelled: by("CANCELLED"),
    nextAt: next?.scheduledAt ?? null,
    lastSentAt: last?.sentAt ?? null,
    percent: total > 0 ? Math.round((done / total) * 100) : 0,
  };
}

/** Kontakt anhand E-Mail finden (ueber Blind-Index). */
export async function findContactByEmail(email: string): Promise<Contact | null> {
  return prisma.contact.findUnique({ where: { emailHash: blindIndex(email) } });
}

export function contactEmail(contact: Contact): string | null {
  return safeDecrypt(contact.email);
}
