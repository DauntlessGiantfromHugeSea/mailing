import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { importMailboxAsSender } from "@/lib/hostingerSync";
import { forgetTransport } from "@/lib/mailer";

/** Uebernimmt ein per Hostinger-API gefundenes Postfach als Absender. */
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/senders", "Keine Berechtigung.");

  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const smtpPassword = String(form.get("smtpPassword") ?? "");
  const fromName = String(form.get("fromName") ?? "").trim();

  if (!email || !smtpPassword || !fromName) {
    return backWithError("/senders?discover=1", "Absendername und SMTP-Passwort sind erforderlich.");
  }

  try {
    const sender = await importMailboxAsSender({
      orderId: String(form.get("orderId") ?? ""),
      mailboxId: String(form.get("mailboxId") ?? ""),
      email,
      fromName,
      smtpPassword,
      dailyLimit: clampInt(form.get("dailyLimit"), 40, 1, 5000),
      replyTo: String(form.get("replyTo") ?? "").trim() || null,
      warmupEnabled: form.get("warmupEnabled") === "1",
    });

    // Falls das Postfach schon existierte, den gecachten Transport verwerfen.
    forgetTransport(sender.id);

    await audit({
      action: "sender.import",
      entity: "Sender",
      entityId: sender.id,
      detail: email,
      userId: session.uid,
    });
    return backWithOk("/senders", `Postfach ${email} übernommen. Bitte einmal „testen“ klicken.`);
  } catch (e) {
    return backWithError("/senders?discover=1", errorMessage(e));
  }
}

function clampInt(raw: FormDataEntryValue | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
