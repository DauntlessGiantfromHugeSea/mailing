import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { parseMinuteOfDay } from "@/lib/sendWindow";
import { launchCampaign } from "@/lib/campaigns";
import { getDefaults } from "@/lib/settings";

/** Legt eine Kampagne an. intent=launch plant und startet sie direkt. */
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/campaigns", "Keine Berechtigung.");

  const form = await req.formData();
  const defaults = await getDefaults();

  const name = String(form.get("name") ?? "").trim();
  const subject = String(form.get("subject") ?? "").trim();
  const bodyHtml = String(form.get("bodyHtml") ?? "").trim();
  const bodyText = String(form.get("bodyText") ?? "").trim();

  if (!name || !subject || !bodyHtml) {
    return backWithError("/campaigns/new", "Name, Betreff und Inhalt sind erforderlich.");
  }

  const sendDays = form
    .getAll("sendDays")
    .map((v) => Number(v))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
  if (sendDays.length === 0) {
    return backWithError("/campaigns/new", "Mindestens ein Wochentag muss ausgewählt sein.");
  }

  const windowStartMinute = parseMinuteOfDay(String(form.get("windowStart") ?? ""), 540);
  const windowEndMinute = parseMinuteOfDay(String(form.get("windowEnd") ?? ""), 1020);
  if (windowEndMinute <= windowStartMinute) {
    return backWithError("/campaigns/new", "Das Sendefenster muss später enden als es beginnt.");
  }

  const tags = String(form.get("tagFilter") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const listId = String(form.get("listId") ?? "").trim() || null;
  const senderIds = form.getAll("senderIds").map(String).filter(Boolean);

  const campaign = await prisma.campaign.create({
    data: {
      name,
      subject,
      bodyHtml,
      bodyText: bodyText || null,
      listId,
      tagFilter: tags.length ? JSON.stringify(tags) : null,
      intervalMinutes: clampInt(form.get("intervalMinutes"), defaults.intervalMinutes, 1, 1440),
      jitterPercent: clampInt(form.get("jitterPercent"), defaults.jitterPercent, 0, 100),
      shuffleRecipients: form.get("shuffleRecipients") === "1",
      timezone: String(form.get("timezone") ?? defaults.timezone).trim() || defaults.timezone,
      sendDays: JSON.stringify(sendDays),
      windowStartMinute,
      windowEndMinute,
      createdById: session.uid,
      senders: senderIds.length
        ? { create: senderIds.map((senderId) => ({ senderId })) }
        : undefined,
    },
  });

  await audit({
    action: "campaign.create",
    entity: "Campaign",
    entityId: campaign.id,
    detail: name,
    userId: session.uid,
  });

  if (String(form.get("intent") ?? "") !== "launch") {
    return backWithOk(`/campaigns/${campaign.id}`, "Kampagne als Entwurf gespeichert.");
  }

  try {
    const res = await launchCampaign(campaign.id);
    await audit({
      action: "campaign.launch",
      entity: "Campaign",
      entityId: campaign.id,
      detail: `${res.recipientCount} Empfänger`,
      userId: session.uid,
    });
    return backWithOk(
      `/campaigns/${campaign.id}`,
      `Kampagne gestartet — ${res.recipientCount} Mails eingeplant.`
    );
  } catch (e) {
    // Kampagne bleibt als Entwurf erhalten, damit die Eingaben nicht verloren sind.
    return backWithError(`/campaigns/${campaign.id}`, errorMessage(e));
  }
}

function clampInt(raw: FormDataEntryValue | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
