import { prisma } from "./db";
import { encryptField, safeDecrypt } from "./crypto";

/** Liest einen Setting-Wert und entschluesselt ihn, falls noetig. */
export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  if (!row) return null;
  return row.encrypted ? safeDecrypt(row.value) : row.value;
}

export async function setSetting(key: string, value: string, encrypted = false): Promise<void> {
  const stored = encrypted ? encryptField(value) : value;
  if (stored === null) {
    await prisma.setting.deleteMany({ where: { key } });
    return;
  }
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: stored, encrypted },
    update: { value: stored, encrypted },
  });
}

export async function deleteSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
}

export const SETTINGS = {
  hostingerToken: "hostinger.apiToken",
  reachProfileUuid: "hostinger.reachProfileUuid",
  mailOrderId: "hostinger.mailOrderId",
  defaultTimezone: "defaults.timezone",
  defaultIntervalMinutes: "defaults.intervalMinutes",
  defaultJitterPercent: "defaults.jitterPercent",
} as const;

export async function getDefaults(): Promise<{
  timezone: string;
  intervalMinutes: number;
  jitterPercent: number;
}> {
  const [tz, interval, jitter] = await Promise.all([
    getSetting(SETTINGS.defaultTimezone),
    getSetting(SETTINGS.defaultIntervalMinutes),
    getSetting(SETTINGS.defaultJitterPercent),
  ]);
  return {
    timezone: tz || "Europe/Berlin",
    intervalMinutes: clampInt(interval, 3, 1, 1440),
    jitterPercent: clampInt(jitter, 60, 0, 100),
  };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
