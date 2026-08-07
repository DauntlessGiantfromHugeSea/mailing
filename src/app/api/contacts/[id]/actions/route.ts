import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";

export async function POST(
  req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/contacts", "Keine Berechtigung.");

  const contact = await prisma.contact.findUnique({ where: { id: params.id } });
  if (!contact) return backWithError("/contacts", "Kontakt nicht gefunden.");

  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  try {
    switch (action) {
      case "suppress": {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { status: "SUPPRESSED" },
        });
        await prisma.suppression.upsert({
          where: { emailHash: contact.emailHash },
          create: { emailHash: contact.emailHash, reason: "manual" },
          update: { reason: "manual" },
        });
        // Offene Sendungen an diese Adresse zurückziehen.
        const cancelled = await prisma.sendJob.updateMany({
          where: { contactId: contact.id, status: "PENDING" },
          data: { status: "SKIPPED", error: "Kontakt manuell gesperrt" },
        });
        await audit({
          action: "contact.suppress",
          entity: "Contact",
          entityId: contact.id,
          userId: session.uid,
        });
        return backWithOk(
          "/contacts",
          cancelled.count > 0
            ? `Kontakt gesperrt — ${cancelled.count} geplante Mail(s) zurückgezogen.`
            : "Kontakt gesperrt."
        );
      }

      case "reactivate": {
        await prisma.contact.update({
          where: { id: contact.id },
          data: { status: "ACTIVE", unsubscribedAt: null, bounceCount: 0 },
        });
        await prisma.suppression.deleteMany({ where: { emailHash: contact.emailHash } });
        await audit({
          action: "contact.reactivate",
          entity: "Contact",
          entityId: contact.id,
          userId: session.uid,
        });
        return backWithOk("/contacts", "Kontakt wieder freigegeben.");
      }

      case "delete": {
        await prisma.contact.delete({ where: { id: contact.id } });
        await audit({
          action: "contact.delete",
          entity: "Contact",
          entityId: contact.id,
          userId: session.uid,
        });
        // Die Sperrliste bleibt bestehen - sonst wuerde ein Reimport eine
        // abgemeldete Adresse wieder anschreiben.
        return backWithOk("/contacts", "Kontakt gelöscht. Ein etwaiger Sperreintrag bleibt bestehen.");
      }

      default:
        return backWithError("/contacts", "Unbekannte Aktion.");
    }
  } catch (e) {
    return backWithError("/contacts", errorMessage(e));
  }
}
