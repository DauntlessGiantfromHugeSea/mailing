import { prisma } from "@/lib/db";
import { assertSmtpTarget } from "@/lib/smtpTarget";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { encryptField } from "@/lib/crypto";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";

/** Absender manuell anlegen. */
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/senders", "Keine Berechtigung.");

  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const fromName = String(form.get("fromName") ?? "").trim();
  const smtpPassword = String(form.get("smtpPassword") ?? "");

  if (!email || !fromName || !smtpPassword) {
    return backWithError("/senders", "Adresse, Absendername und SMTP-Passwort sind erforderlich.");
  }

  const port = Number(form.get("smtpPort") ?? 465);
  const replyTo = String(form.get("replyTo") ?? "").trim();
  const smtpHost = String(form.get("smtpHost") ?? "smtp.hostinger.com").trim() || "smtp.hostinger.com";
  try {
    await assertSmtpTarget(smtpHost, port);
  } catch (e) {
    return backWithError("/senders", e instanceof Error ? e.message : "SMTP-Server nicht erlaubt.");
  }

  try {
    const sender = await prisma.sender.create({
      data: {
        label: email,
        email,
        fromName,
        replyTo: replyTo || null,
        smtpHost,
        smtpPort: port,
        smtpSecure: port === 465,
        smtpUser: String(form.get("smtpUser") ?? "").trim() || email,
        smtpPassEnc: encryptField(smtpPassword)!,
        dailyLimit: clampInt(form.get("dailyLimit"), 40, 1, 5000),
        warmupEnabled: form.get("warmupEnabled") === "1",
      },
    });

    await audit({
      action: "sender.create",
      entity: "Sender",
      entityId: sender.id,
      detail: email,
      userId: session.uid,
    });
    return backWithOk("/senders", `Absender ${email} angelegt. Bitte einmal „testen“ klicken.`);
  } catch (e) {
    return backWithError("/senders", errorMessage(e));
  }
}

function clampInt(raw: FormDataEntryValue | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
