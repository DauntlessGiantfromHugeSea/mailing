import type { Campaign } from "@prisma/client";
import { makeRng, shuffle, jitteredGapSeconds } from "./random";
import { addWorkSeconds, nextWindowOpening, windowFrom, type WindowSpec } from "./sendWindow";

// Planung eines Kampagnen-Zeitplans.
//
// Reine Funktionen, keine DB, keine Zeit-Abhaengigkeit ausser dem uebergebenen
// Startzeitpunkt. Dadurch kann die UI mit denselben Funktionen eine exakte
// Vorschau rendern, die spaeter 1:1 so eingeplant wird.

export interface PacingSpec {
  intervalMinutes: number;
  jitterPercent: number;
  shuffle: boolean;
  seed: string;
}

export function pacingFrom(campaign: Campaign): PacingSpec {
  return {
    intervalMinutes: campaign.intervalMinutes,
    jitterPercent: campaign.jitterPercent,
    shuffle: campaign.shuffleRecipients,
    seed: campaign.randomSeed ?? campaign.id,
  };
}

export interface PlannedSlot<T> {
  item: T;
  sequence: number;
  scheduledAt: Date;
  /** Abstand zum vorherigen Slot in Sekunden (0 beim ersten). */
  gapSeconds: number;
}

/**
 * Baut den Zeitplan: Empfaenger mischen, dann fortlaufend zufaellige Abstaende
 * addieren - aber nur innerhalb des Sendefensters.
 *
 * Die erste Mail geht nicht sofort raus, sondern nach einem ersten (halben)
 * Jitter-Abstand. Ein Versand, der in der Sekunde des Klicks auf "Starten"
 * beginnt, sieht nach Automat aus.
 */
export function buildSchedule<T>(
  items: readonly T[],
  startAt: Date,
  pacing: PacingSpec,
  window: WindowSpec
): PlannedSlot<T>[] {
  if (items.length === 0) return [];

  const rng = makeRng(pacing.seed);
  const ordered = pacing.shuffle ? shuffle(items, rng) : items.slice();

  const out: PlannedSlot<T>[] = [];
  let cursor = nextWindowOpening(startAt, window);

  for (let i = 0; i < ordered.length; i++) {
    const gap =
      i === 0
        ? Math.round(jitteredGapSeconds(pacing.intervalMinutes, pacing.jitterPercent, rng) / 2)
        : jitteredGapSeconds(pacing.intervalMinutes, pacing.jitterPercent, rng);

    cursor = addWorkSeconds(cursor, gap, window);
    out.push({ item: ordered[i], sequence: i, scheduledAt: cursor, gapSeconds: gap });
  }
  return out;
}

export interface SchedulePreview {
  count: number;
  first?: Date;
  last?: Date;
  /** Durchschnittlicher Abstand in Minuten. */
  avgGapMinutes: number;
  minGapMinutes: number;
  maxGapMinutes: number;
  /** Anzahl unterschiedlicher Kalendertage, ueber die sich der Versand zieht. */
  spanDays: number;
  slots: { sequence: number; scheduledAt: Date; gapSeconds: number }[];
}

/**
 * Kennzahlen + die ersten `sampleSize` Slots fuer die Vorschau in der UI.
 * `recipientCount` statt echter Empfaenger, damit die Vorschau ohne DB-Zugriff
 * auf Kontaktdaten auskommt.
 */
export function previewSchedule(
  recipientCount: number,
  startAt: Date,
  pacing: PacingSpec,
  window: WindowSpec,
  sampleSize = 12
): SchedulePreview {
  const indices = Array.from({ length: recipientCount }, (_, i) => i);
  const slots = buildSchedule(indices, startAt, pacing, window);

  if (slots.length === 0) {
    return { count: 0, avgGapMinutes: 0, minGapMinutes: 0, maxGapMinutes: 0, spanDays: 0, slots: [] };
  }

  const gaps = slots.slice(1).map((s) => s.gapSeconds);
  const avg = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0;
  const days = new Set(slots.map((s) => s.scheduledAt.toISOString().slice(0, 10)));

  return {
    count: slots.length,
    first: slots[0].scheduledAt,
    last: slots[slots.length - 1].scheduledAt,
    avgGapMinutes: Math.round((avg / 60) * 10) / 10,
    minGapMinutes: gaps.length ? Math.round((Math.min(...gaps) / 60) * 10) / 10 : 0,
    maxGapMinutes: gaps.length ? Math.round((Math.max(...gaps) / 60) * 10) / 10 : 0,
    spanDays: days.size,
    slots: slots.slice(0, sampleSize).map((s) => ({
      sequence: s.sequence,
      scheduledAt: s.scheduledAt,
      gapSeconds: s.gapSeconds,
    })),
  };
}

export function windowOf(campaign: Campaign): WindowSpec {
  return windowFrom(campaign);
}
