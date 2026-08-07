import { DateTime } from "luxon";

// Sendefenster-Arithmetik in der Zeitzone der Kampagne.
//
// Ein Zeitplan mit Minutenabstaenden ist nur dann glaubhaft, wenn er sich an
// Bueroezeiten haelt: 40 Mails im 3-Minuten-Takt laufen sonst quer durch die
// Nacht. Diese Funktionen falten eine fortlaufende Sekundensumme in erlaubte
// Zeitfenster (Wochentage + Uhrzeitbereich).

export interface WindowSpec {
  timezone: string;
  /** ISO-Wochentage, 1 = Montag ... 7 = Sonntag. */
  days: number[];
  /** Minuten seit Mitternacht, inklusive. */
  startMinute: number;
  /** Minuten seit Mitternacht, exklusiv. */
  endMinute: number;
}

export function parseDays(json: string | null | undefined): number[] {
  if (!json) return [1, 2, 3, 4, 5];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [1, 2, 3, 4, 5];
    const days = arr
      .map((d) => Number(d))
      .filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    return days.length ? Array.from(new Set(days)).sort() : [1, 2, 3, 4, 5];
  } catch {
    return [1, 2, 3, 4, 5];
  }
}

export function windowFrom(campaign: {
  timezone: string;
  sendDays: string;
  windowStartMinute: number;
  windowEndMinute: number;
}): WindowSpec {
  return {
    timezone: campaign.timezone || "Europe/Berlin",
    days: parseDays(campaign.sendDays),
    startMinute: campaign.windowStartMinute,
    endMinute: campaign.windowEndMinute,
  };
}

function isValidWindow(w: WindowSpec): boolean {
  return w.days.length > 0 && w.endMinute > w.startMinute;
}

/** Liegt `at` innerhalb des Fensters? */
export function isInWindow(at: Date, w: WindowSpec): boolean {
  if (!isValidWindow(w)) return false;
  const dt = DateTime.fromJSDate(at, { zone: w.timezone });
  if (!w.days.includes(dt.weekday)) return false;
  const minute = dt.hour * 60 + dt.minute;
  return minute >= w.startMinute && minute < w.endMinute;
}

/**
 * Naechster Zeitpunkt >= `from`, der im Fenster liegt. Liegt `from` bereits
 * darin, wird `from` unveraendert zurueckgegeben.
 */
export function nextWindowOpening(from: Date, w: WindowSpec): Date {
  if (!isValidWindow(w)) return from;
  let dt = DateTime.fromJSDate(from, { zone: w.timezone });

  // Maximal 14 Tage vorspulen - danach ist die Konfiguration kaputt.
  for (let i = 0; i < 15; i++) {
    if (w.days.includes(dt.weekday)) {
      const minute = dt.hour * 60 + dt.minute + dt.second / 60;
      if (minute < w.startMinute) {
        return dt.startOf("day").plus({ minutes: w.startMinute }).toJSDate();
      }
      if (minute < w.endMinute) {
        return dt.toJSDate();
      }
    }
    // Naechster Tag, Fensterbeginn.
    dt = dt.plus({ days: 1 }).startOf("day").plus({ minutes: w.startMinute });
  }
  return dt.toJSDate();
}

/**
 * Addiert `seconds` "Sendezeit" auf `from` und ueberspringt dabei alle Zeiten
 * ausserhalb des Fensters.
 *
 * Beispiel: Fenster endet 17:00, `from` = 16:58, `seconds` = 300 (5 min).
 * Ergebnis: naechster Sendetag 09:02 - die restlichen 3 Minuten werden am
 * Folgetag "weitergezaehlt", die Nacht dazwischen zaehlt nicht.
 */
export function addWorkSeconds(from: Date, seconds: number, w: WindowSpec): Date {
  if (!isValidWindow(w)) return new Date(from.getTime() + seconds * 1000);

  let cursor = DateTime.fromJSDate(nextWindowOpening(from, w), { zone: w.timezone });
  let remaining = Math.max(0, seconds);

  for (let guard = 0; guard < 2000 && remaining > 0; guard++) {
    const dayEnd = cursor.startOf("day").plus({ minutes: w.endMinute });
    const availableSec = Math.max(0, dayEnd.diff(cursor, "seconds").seconds);

    if (remaining <= availableSec) {
      return cursor.plus({ seconds: remaining }).toJSDate();
    }
    remaining -= availableSec;
    // Auf den naechsten Fensterbeginn springen.
    cursor = DateTime.fromJSDate(
      nextWindowOpening(cursor.startOf("day").plus({ days: 1 }).toJSDate(), w),
      { zone: w.timezone }
    );
  }
  return cursor.toJSDate();
}

/** Sekunden Sendezeit, die pro Fenstertag zur Verfuegung stehen. */
export function windowSecondsPerDay(w: WindowSpec): number {
  return Math.max(0, (w.endMinute - w.startMinute) * 60);
}

export function formatMinuteOfDay(minute: number): string {
  const m = ((minute % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function parseMinuteOfDay(value: string, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

export const DAY_LABELS: Record<number, string> = {
  1: "Mo",
  2: "Di",
  3: "Mi",
  4: "Do",
  5: "Fr",
  6: "Sa",
  7: "So",
};

export function formatInZone(at: Date, timezone: string): string {
  return DateTime.fromJSDate(at, { zone: timezone }).toFormat("dd.MM.yyyy HH:mm:ss");
}
