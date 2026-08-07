import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";

// Eigenes Passwort aendern. Bewusst nur fuer den angemeldeten Benutzer selbst -
// eine Benutzerverwaltung (fremde Passwoerter setzen, Konten anlegen) gibt es
// noch nicht.

const MIN_LENGTH = 12;

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");

  const back = "/account";
  const form = await req.formData();
  const current = String(form.get("currentPassword") ?? "");
  const next = String(form.get("newPassword") ?? "");
  const confirm = String(form.get("confirmPassword") ?? "");

  if (!current || !next || !confirm) {
    return backWithError(back, "Bitte alle drei Felder ausfüllen.");
  }
  if (next !== confirm) {
    return backWithError(back, "Die beiden neuen Passwörter stimmen nicht überein.");
  }
  if (next.length < MIN_LENGTH) {
    return backWithError(back, `Das neue Passwort muss mindestens ${MIN_LENGTH} Zeichen haben.`);
  }
  if (next === current) {
    return backWithError(back, "Das neue Passwort ist mit dem alten identisch.");
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: session.uid } });
    if (!user) return backWithError(back, "Benutzerkonto nicht gefunden.");

    if (!(await bcrypt.compare(current, user.passwordHash))) {
      await audit({
        action: "account.passwordChangeFailed",
        entity: "User",
        entityId: user.id,
        detail: "falsches aktuelles Passwort",
        userId: user.id,
      });
      return backWithError(back, "Das aktuelle Passwort ist falsch.");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await bcrypt.hash(next, 10) },
    });

    await audit({
      action: "account.passwordChanged",
      entity: "User",
      entityId: user.id,
      userId: user.id,
    });

    // Hinweis: die Session bleibt gueltig. Das Session-JWT ist zustandslos und
    // enthaelt keinen Passwort-Bezug, andere angemeldete Geraete koennen also
    // ohne ein Token-Versionsfeld nicht abgemeldet werden. Fuer dieses Tool
    // (kleiner, bekannter Nutzerkreis) ist das vertretbar.
    return backWithOk(
      back,
      "Passwort geändert. Beim nächsten Anmelden gilt das neue Passwort."
    );
  } catch (e) {
    return backWithError(back, errorMessage(e));
  }
}
