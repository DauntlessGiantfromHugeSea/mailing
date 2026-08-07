import crypto from "node:crypto";

/**
 * Deterministischer PRNG (mulberry32). Gleicher Seed => gleiche Folge.
 *
 * Wichtig fuer die Kampagnenplanung: der Zeitplan soll zufaellig *aussehen*,
 * aber reproduzierbar sein. So laesst sich in der UI eine Vorschau rendern,
 * die exakt dem entspricht, was spaeter tatsaechlich eingeplant wird, und ein
 * Neuplanen nach einer Pause erzeugt keine voellig anderen Abstaende.
 */
export function makeRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function newSeed(): string {
  return crypto.randomBytes(8).toString("hex");
}

/** Fisher-Yates mit vorgegebenem RNG. Verändert das Original nicht. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Zieht einen zufaelligen Abstand um `baseMinutes` herum.
 *
 * `jitterPercent` = 60 bedeutet: Ergebnis liegt gleichverteilt in
 * [base * 0.4, base * 1.6]. Rueckgabe in Sekunden, damit die Abstaende nicht
 * alle auf runden Minuten liegen - genau das wuerde einen Bot verraten.
 */
export function jitteredGapSeconds(
  baseMinutes: number,
  jitterPercent: number,
  rng: () => number
): number {
  const base = Math.max(0, baseMinutes) * 60;
  const spread = Math.min(100, Math.max(0, jitterPercent)) / 100;
  const factor = 1 - spread + rng() * spread * 2;
  // Minimum 20s: unterhalb davon ist "im Minutentakt" nicht mehr glaubhaft.
  return Math.max(20, Math.round(base * factor));
}
