import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { previewSchedule } from "@/lib/schedule";
import { parseMinuteOfDay } from "@/lib/sendWindow";
import { loadSenderStats } from "@/lib/senders";
import { jsonError } from "@/lib/http";

// Live-Vorschau der Taktung fuer das Kampagnen-Formular. Nutzt exakt dieselbe
// previewSchedule()-Funktion wie das spaetere Einplanen der Jobs, damit die
// angezeigten Zeiten nicht von der Realitaet abweichen.

const Body = z.object({
  listId: z.string().nullable().optional(),
  tagFilter: z.string().optional().default(""),
  intervalMinutes: z.number().int().min(1).max(1440),
  jitterPercent: z.number().int().min(0).max(100),
  shuffleRecipients: z.boolean(),
  timezone: z.string().min(1),
  sendDays: z.array(z.number().int().min(1).max(7)),
  windowStart: z.string(),
  windowEnd: z.string(),
  senderIds: z.array(z.string()).optional().default([]),
});

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return jsonError("Nicht angemeldet", 401);
  // Die Vorschau gehört zum Kampagnen-Formular -> nur für Bearbeiter
  // (Sicherheits-Audit 2026-10: Rechenlast und Datenzugriff begrenzen).
  if (!canEdit(session)) return jsonError("Keine Berechtigung", 403);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Ungültige Eingabe", 422);
  const body = parsed.data;

  if (body.sendDays.length === 0) {
    return NextResponse.json({ error: "Mindestens ein Wochentag muss ausgewählt sein." });
  }

  const startMinute = parseMinuteOfDay(body.windowStart, 540);
  const endMinute = parseMinuteOfDay(body.windowEnd, 1020);
  if (endMinute <= startMinute) {
    return NextResponse.json({ error: "Das Sendefenster muss später enden als es beginnt." });
  }

  // --- Empfängerzahl bestimmen (ohne Kontaktdaten zu laden)
  const tags = body.tagFilter
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const where = {
    status: "ACTIVE" as const,
    ...(body.listId ? { memberships: { some: { listId: body.listId } } } : {}),
  };

  let recipientCount: number;
  if (tags.length === 0) {
    recipientCount = await prisma.contact.count({ where });
  } else {
    // Tags liegen als JSON-Array-String, daher in JS filtern.
    const candidates = await prisma.contact.findMany({ where, select: { tags: true } });
    recipientCount = candidates.filter((c) => {
      if (!c.tags) return false;
      try {
        const list = JSON.parse(c.tags);
        return Array.isArray(list) && tags.some((t) => list.includes(t));
      } catch {
        return false;
      }
    }).length;
  }

  const suppressed = await prisma.suppression.count();

  const preview = previewSchedule(
    recipientCount,
    new Date(),
    {
      intervalMinutes: body.intervalMinutes,
      jitterPercent: body.jitterPercent,
      shuffle: body.shuffleRecipients,
      // Fester Seed: die Vorschau soll beim Tippen nicht bei jedem Tastendruck
      // andere Zahlen zeigen.
      seed: "preview",
    },
    {
      timezone: body.timezone,
      days: body.sendDays,
      startMinute,
      endMinute,
    },
    12
  );

  // --- Kapazitätswarnung
  const senders = body.senderIds.length
    ? await prisma.sender.findMany({ where: { id: { in: body.senderIds }, active: true } })
    : await prisma.sender.findMany({ where: { active: true } });
  const stats = await loadSenderStats(senders);
  const capacityToday = stats.reduce((sum, x) => sum + x.remaining, 0);

  const warnings: string[] = [];
  if (recipientCount === 0) {
    warnings.push(
      suppressed > 0
        ? "Keine passenden Empfänger. Prüfe Liste und Tag-Filter — abgemeldete Adressen sind ausgeschlossen."
        : "Keine passenden Empfänger. Bitte zuerst Kontakte importieren."
    );
  }
  if (senders.length === 0) {
    warnings.push("Kein aktiver Absender ausgewählt — der Versand kann nicht starten.");
  } else if (recipientCount > capacityToday) {
    warnings.push(
      `Die Absender können heute nur ${capacityToday} Mails abgeben. Der Rest läuft automatisch an den Folgetagen weiter.`
    );
  }

  return NextResponse.json({
    recipientCount: preview.count,
    first: preview.first?.toISOString() ?? null,
    last: preview.last?.toISOString() ?? null,
    avgGapMinutes: preview.avgGapMinutes,
    minGapMinutes: preview.minGapMinutes,
    maxGapMinutes: preview.maxGapMinutes,
    spanDays: preview.spanDays,
    slots: preview.slots.map((s) => ({
      sequence: s.sequence,
      scheduledAt: s.scheduledAt.toISOString(),
      gapSeconds: s.gapSeconds,
    })),
    capacityToday,
    warning: warnings.length ? warnings.join(" ") : undefined,
  });
}
