import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { forgetTransport, verifySender } from "@/lib/mailer";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/senders", "Keine Berechtigung.");

  const sender = await prisma.sender.findUnique({ where: { id: params.id } });
  if (!sender) return backWithError("/senders", "Absender nicht gefunden.");

  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  try {
    switch (action) {
      case "verify": {
        const res = await verifySender(sender);
        await prisma.sender.update({
          where: { id: sender.id },
          data: {
            lastCheckAt: new Date(),
            lastCheckOk: res.ok,
            lastCheckError: res.ok ? null : res.error ?? "unbekannter Fehler",
          },
        });
        return res.ok
          ? backWithOk("/senders", `SMTP-Verbindung zu ${sender.email} funktioniert.`)
          : backWithError("/senders", `SMTP-Test fehlgeschlagen: ${res.error}`);
      }

      case "toggle": {
        const updated = await prisma.sender.update({
          where: { id: sender.id },
          data: { active: !sender.active },
        });
        await audit({
          action: "sender.toggle",
          entity: "Sender",
          entityId: sender.id,
          detail: updated.active ? "aktiv" : "inaktiv",
          userId: session.uid,
        });
        return backWithOk(
          "/senders",
          updated.active
            ? `${sender.email} ist wieder aktiv.`
            : `${sender.email} deaktiviert — laufende Kampagnen nutzen dieses Postfach nicht mehr.`
        );
      }

      case "delete": {
        const pending = await prisma.sendJob.count({
          where: { senderId: sender.id, status: { in: ["PENDING", "SENDING"] } },
        });
        if (pending > 0) {
          return backWithError(
            "/senders",
            `${sender.email} hat noch ${pending} offene Sendung(en). Bitte zuerst deaktivieren oder die Kampagne abschließen.`
          );
        }
        forgetTransport(sender.id);
        await prisma.sender.delete({ where: { id: sender.id } });
        await audit({
          action: "sender.delete",
          entity: "Sender",
          entityId: sender.id,
          detail: sender.email,
          userId: session.uid,
        });
        return backWithOk("/senders", `${sender.email} gelöscht.`);
      }

      default:
        return backWithError("/senders", "Unbekannte Aktion.");
    }
  } catch (e) {
    return backWithError("/senders", errorMessage(e));
  }
}
