// Prüft die Planungslogik (reine Funktionen, keine DB, kein SMTP):
//   - Abstände sind randomisiert und liegen in den erwarteten Grenzen
//   - jeder Termin liegt im Sendefenster (Wochentag + Uhrzeit)
//   - der Takt läuft am Folgetag weiter, statt nachts durchzulaufen
//   - gleicher Seed => gleicher Plan, anderer Seed => anderer Plan
//
// Aufruf:  npx tsx scripts/test-schedule.ts

import { DateTime } from "luxon";
import { buildSchedule } from "../src/lib/schedule";
import { isInWindow, type WindowSpec } from "../src/lib/sendWindow";

let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const TZ = "Europe/Berlin";
const window: WindowSpec = { timezone: TZ, days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 17 * 60 };

// Start: Montag, 06.04.2026, 09:00 Berlin
const start = DateTime.fromISO("2026-04-06T09:00:00", { zone: TZ }).toJSDate();

console.log("\n=== 1) Randomisierte Abstände ===");
{
  const items = Array.from({ length: 60 }, (_, i) => i);
  const slots = buildSchedule(items, start, { intervalMinutes: 3, jitterPercent: 60, shuffle: true, seed: "s1" }, window);

  check("60 Slots erzeugt", slots.length === 60, `${slots.length}`);

  // Abstände ohne Tageswechsel betrachten (Tageswechsel erzeugt große Lücken).
  const sameDayGaps = slots
    .slice(1)
    .filter((s, i) => sameDay(slots[i].scheduledAt, s.scheduledAt))
    .map((s) => s.gapSeconds);

  const min = Math.min(...sameDayGaps);
  const max = Math.max(...sameDayGaps);
  const avg = sameDayGaps.reduce((a, b) => a + b, 0) / sameDayGaps.length;

  // 3 min ±60% => 72s .. 288s
  check("Abstände innerhalb 72–288 s", min >= 72 && max <= 288, `min=${min}s max=${max}s`);
  check("Mittelwert nahe 180 s", Math.abs(avg - 180) < 25, `avg=${Math.round(avg)}s`);

  // Streuung statistisch prüfen statt „alle Werte verschieden“: bei 59 Ziehungen
  // aus ~215 möglichen Sekundenwerten sind Dopplungen völlig normal
  // (erwartete Anzahl verschiedener Werte ≈ 50).
  const distinct = new Set(sameDayGaps).size;
  check("Abstände breit gestreut", distinct > sameDayGaps.length * 0.6, `${distinct} verschiedene von ${sameDayGaps.length} Abständen`);

  const variance = sameDayGaps.reduce((sum, g) => sum + (g - avg) ** 2, 0) / sameDayGaps.length;
  const stddev = Math.sqrt(variance);
  // Gleichverteilung auf ±108 s hat σ = 108/√3 ≈ 62 s.
  check("Standardabweichung passt zur Gleichverteilung", stddev > 45 && stddev < 80, `σ=${Math.round(stddev)}s (erwartet ≈62s)`);

  // Beide Hälften des erlaubten Bereichs müssen vorkommen - sonst wäre der
  // Jitter einseitig.
  const below = sameDayGaps.filter((g) => g < 180).length;
  const above = sameDayGaps.filter((g) => g > 180).length;
  check("Jitter geht in beide Richtungen", below > 5 && above > 5, `${below} kürzer / ${above} länger als 180 s`);
  check(
    "Keine runden Minutenwerte erzwungen",
    sameDayGaps.some((g) => g % 60 !== 0),
    "Abstände liegen auf Sekunden, nicht auf ganzen Minuten"
  );
}

console.log("\n=== 2) Alle Termine im Sendefenster ===");
{
  const items = Array.from({ length: 300 }, (_, i) => i);
  const slots = buildSchedule(items, start, { intervalMinutes: 4, jitterPercent: 80, shuffle: true, seed: "s2" }, window);

  const outside = slots.filter((s) => !isInWindow(s.scheduledAt, window));
  check("kein Termin außerhalb des Fensters", outside.length === 0, `${outside.length} Verstöße von ${slots.length}`);

  const weekend = slots.filter((s) => {
    const wd = DateTime.fromJSDate(s.scheduledAt, { zone: TZ }).weekday;
    return wd === 6 || wd === 7;
  });
  check("kein Termin am Wochenende", weekend.length === 0, `${weekend.length} am Sa/So`);

  const hours = slots.map((s) => DateTime.fromJSDate(s.scheduledAt, { zone: TZ }).hour);
  check("alle Uhrzeiten zwischen 09 und 16 Uhr", Math.min(...hours) >= 9 && Math.max(...hours) <= 16, `${Math.min(...hours)}–${Math.max(...hours)} Uhr`);

  const days = new Set(slots.map((s) => DateTime.fromJSDate(s.scheduledAt, { zone: TZ }).toISODate()));
  check("Versand streckt sich über mehrere Tage", days.size > 1, `${days.size} Tage: ${[...days].slice(0, 6).join(", ")}…`);
}

console.log("\n=== 3) Fenster-Ende wird korrekt umgebrochen ===");
{
  // Start Freitag 16:50 — nach wenigen Mails muss auf Montag 09:xx gesprungen werden.
  const friday = DateTime.fromISO("2026-04-10T16:50:00", { zone: TZ }).toJSDate();
  const slots = buildSchedule(
    Array.from({ length: 12 }, (_, i) => i),
    friday,
    { intervalMinutes: 3, jitterPercent: 0, shuffle: false, seed: "s3" },
    window
  );

  const zoned = slots.map((s) => DateTime.fromJSDate(s.scheduledAt, { zone: TZ }));
  const fridaySlots = zoned.filter((d) => d.weekday === 5);
  const mondaySlots = zoned.filter((d) => d.weekday === 1);

  check("einige Mails noch am Freitag", fridaySlots.length > 0, `${fridaySlots.length}`);
  check("Rest am Montag (Sa/So übersprungen)", mondaySlots.length > 0, `${mondaySlots.length}`);
  check(
    "kein Termin nach 17:00 am Freitag",
    fridaySlots.every((d) => d.hour * 60 + d.minute < 17 * 60),
    fridaySlots.map((d) => d.toFormat("HH:mm:ss")).join(", ")
  );
  check(
    "Montag beginnt frühestens 09:00",
    mondaySlots.every((d) => d.hour * 60 + d.minute >= 9 * 60),
    mondaySlots.slice(0, 3).map((d) => d.toFormat("HH:mm:ss")).join(", ")
  );
  console.log(`        Plan: ${zoned.map((d) => d.toFormat("EEE HH:mm")).join(" | ")}`);
}

console.log("\n=== 4) Reproduzierbarkeit über den Seed ===");
{
  const items = Array.from({ length: 25 }, (_, i) => `k${i}`);
  const a = buildSchedule(items, start, { intervalMinutes: 3, jitterPercent: 60, shuffle: true, seed: "same" }, window);
  const b = buildSchedule(items, start, { intervalMinutes: 3, jitterPercent: 60, shuffle: true, seed: "same" }, window);
  const c = buildSchedule(items, start, { intervalMinutes: 3, jitterPercent: 60, shuffle: true, seed: "other" }, window);

  const key = (x: typeof a) => x.map((s) => `${s.item}@${s.scheduledAt.toISOString()}`).join(";");
  check("gleicher Seed ergibt identischen Plan", key(a) === key(b));
  check("anderer Seed ergibt anderen Plan", key(a) !== key(c));

  const orderA = a.map((s) => s.item).join(",");
  const original = items.join(",");
  check("Empfänger wurden gemischt", orderA !== original, `${a.slice(0, 5).map((s) => s.item).join(", ")}…`);
  check("alle Empfänger genau einmal", new Set(a.map((s) => s.item)).size === items.length);
}

console.log("\n=== 5) Erste Mail geht nicht sofort raus ===");
{
  const slots = buildSchedule([1], start, { intervalMinutes: 5, jitterPercent: 50, shuffle: false, seed: "s5" }, window);
  const delaySec = (slots[0].scheduledAt.getTime() - start.getTime()) / 1000;
  check("Startverzögerung > 20 s", delaySec > 20, `${Math.round(delaySec)} s nach Klick auf „Starten“`);
}

console.log("\n=== 6) Jitter 0 % ergibt exakt gleichmäßigen Takt ===");
{
  const slots = buildSchedule(
    Array.from({ length: 8 }, (_, i) => i),
    start,
    { intervalMinutes: 6, jitterPercent: 0, shuffle: false, seed: "s6" },
    window
  );
  const gaps = slots.slice(1).map((s) => s.gapSeconds);
  check("alle Abstände exakt 360 s", gaps.every((g) => g === 360), `${[...new Set(gaps)].join(",")}`);
}

console.log(
  failures === 0
    ? "\n✅ Alle Planungs-Tests bestanden.\n"
    : `\n❌ ${failures} Test(s) fehlgeschlagen.\n`
);
process.exit(failures === 0 ? 0 : 1);

function sameDay(a: Date, b: Date): boolean {
  return (
    DateTime.fromJSDate(a, { zone: TZ }).toISODate() === DateTime.fromJSDate(b, { zone: TZ }).toISODate()
  );
}
