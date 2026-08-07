// Client-sichere Wochentags-Labels (ISO: 1 = Montag ... 7 = Sonntag).
// Bewusst getrennt von sendWindow.ts, damit Client-Komponenten nicht luxon
// mitbundeln muessen.

export const DAY_LABELS: Record<number, string> = {
  1: "Mo",
  2: "Di",
  3: "Mi",
  4: "Do",
  5: "Fr",
  6: "Sa",
  7: "So",
};

export const DAY_LABELS_LONG: Record<number, string> = {
  1: "Montag",
  2: "Dienstag",
  3: "Mittwoch",
  4: "Donnerstag",
  5: "Freitag",
  6: "Samstag",
  7: "Sonntag",
};

export function formatDays(days: number[]): string {
  if (days.length === 0) return "—";
  const sorted = [...days].sort();
  // Zusammenhängende Bereiche verdichten: [1,2,3,4,5] -> "Mo–Fr"
  const parts: string[] = [];
  let runStart = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur !== prev + 1) {
      parts.push(
        runStart === prev
          ? DAY_LABELS[runStart]
          : `${DAY_LABELS[runStart]}–${DAY_LABELS[prev]}`
      );
      runStart = cur;
    }
    prev = cur;
  }
  return parts.join(", ");
}
