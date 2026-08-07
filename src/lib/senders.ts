import type { Sender } from "@prisma/client";
import { prisma } from "./db";

// Absender-Rotation mit Tageslimit und Warmup.
//
// Wie bei instantly.ai wird das Volumen ueber mehrere Postfaecher verteilt.
// Zwei Regeln bestimmen, wer eine Mail bekommt:
//   1. Tageslimit (ggf. durch Warmup reduziert) darf nicht ueberschritten sein.
//   2. Unter den zulaessigen Absendern gewinnt der, der am wenigsten
//      ausgelastet ist - bei Gleichstand der, der am laengsten nichts
//      gesendet hat.

/**
 * Effektives Tageslimit. Bei aktivem Warmup startet der Absender bei
 * `warmupStart` und steigt pro Tag um `warmupStep`, gedeckelt durch
 * `dailyLimit`.
 */
export function effectiveDailyLimit(sender: Sender, now = new Date()): number {
  if (!sender.warmupEnabled) return sender.dailyLimit;
  const startedAt = sender.warmupStartedAt;
  if (!startedAt) return Math.min(sender.warmupStart, sender.dailyLimit);

  const days = Math.floor((now.getTime() - startedAt.getTime()) / 86_400_000);
  const ramped = sender.warmupStart + Math.max(0, days) * sender.warmupStep;
  return Math.max(1, Math.min(ramped, sender.dailyLimit));
}

export function warmupDay(sender: Sender, now = new Date()): number | null {
  if (!sender.warmupEnabled || !sender.warmupStartedAt) return null;
  return Math.floor((now.getTime() - sender.warmupStartedAt.getTime()) / 86_400_000) + 1;
}

/** Beginn des aktuellen Tages in UTC - Basis fuer die Tageszaehlung. */
function startOfDayUtc(now = new Date()): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export interface SenderLoad {
  sender: Sender;
  sentToday: number;
  limit: number;
  remaining: number;
  lastSentAt: Date | null;
}

/** Tagesauslastung aller uebergebenen Absender. */
export async function loadSenderStats(senders: Sender[], now = new Date()): Promise<SenderLoad[]> {
  if (senders.length === 0) return [];
  const ids = senders.map((s) => s.id);
  const since = startOfDayUtc(now);

  const [grouped, lastSends] = await Promise.all([
    prisma.sendJob.groupBy({
      by: ["senderId"],
      where: { senderId: { in: ids }, status: "SENT", sentAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.sendJob.groupBy({
      by: ["senderId"],
      where: { senderId: { in: ids }, status: "SENT" },
      _max: { sentAt: true },
    }),
  ]);

  const counts = new Map(grouped.map((g) => [g.senderId, g._count._all]));
  const lasts = new Map(lastSends.map((g) => [g.senderId, g._max.sentAt]));

  return senders.map((sender) => {
    const sentToday = counts.get(sender.id) ?? 0;
    const limit = effectiveDailyLimit(sender, now);
    return {
      sender,
      sentToday,
      limit,
      remaining: Math.max(0, limit - sentToday),
      lastSentAt: lasts.get(sender.id) ?? null,
    };
  });
}

/**
 * Waehlt den naechsten Absender. null = alle Postfaecher haben ihr Tageslimit
 * erreicht; der Aufrufer sollte den Job dann liegen lassen, nicht als Fehler
 * markieren.
 */
export async function pickSender(candidates: Sender[], now = new Date()): Promise<Sender | null> {
  const active = candidates.filter((s) => s.active);
  if (active.length === 0) return null;

  const stats = (await loadSenderStats(active, now)).filter((s) => s.remaining > 0);
  if (stats.length === 0) return null;

  stats.sort((a, b) => {
    // Relative Auslastung zuerst - so bleiben grosse und kleine Postfaecher
    // proportional belastet.
    const ua = a.sentToday / Math.max(1, a.limit);
    const ub = b.sentToday / Math.max(1, b.limit);
    if (ua !== ub) return ua - ub;
    const ta = a.lastSentAt?.getTime() ?? 0;
    const tb = b.lastSentAt?.getTime() ?? 0;
    return ta - tb;
  });

  return stats[0].sender;
}

/** Absender, die eine Kampagne benutzen darf. Keine Zuordnung = alle aktiven. */
export async function sendersForCampaign(campaignId: string): Promise<Sender[]> {
  const assigned = await prisma.campaignSender.findMany({
    where: { campaignId },
    include: { sender: true },
  });
  if (assigned.length > 0) return assigned.map((a) => a.sender).filter((s) => s.active);
  return prisma.sender.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } });
}

/**
 * Wie viele Mails koennen die uebergebenen Absender heute noch abgeben?
 * Wird beim Planen als Plausibilitaetshinweis in der UI benutzt.
 */
export async function totalRemainingToday(senders: Sender[], now = new Date()): Promise<number> {
  const stats = await loadSenderStats(senders, now);
  return stats.reduce((sum, s) => sum + s.remaining, 0);
}
