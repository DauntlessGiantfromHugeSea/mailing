import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { isValidEmail, upsertContacts } from "@/lib/contacts";

// Einzelnen Kontakt anlegen. Ohne diesen Weg blieb nur der CSV-Import - für
// zwei oder drei Adressen unnötig umständlich.

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/contacts", "Keine Berechtigung.");

  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();

  if (!isValidEmail(email)) {
    return backWithError("/contacts", `„${email || "(leer)"}“ ist keine gültige E-Mail-Adresse.`);
  }

  // Zielliste: vorhandene wählen oder neue anlegen.
  let listId = String(form.get("listId") ?? "").trim() || null;
  const newListName = String(form.get("newListName") ?? "").trim();

  try {
    if (newListName) {
      const list = await prisma.contactList.create({ data: { name: newListName } });
      listId = list.id;
    }

    const tags = String(form.get("tags") ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    const stats = await upsertContacts(
      [
        {
          email,
          firstName: String(form.get("firstName") ?? "").trim() || null,
          lastName: String(form.get("lastName") ?? "").trim() || null,
          company: String(form.get("company") ?? "").trim() || null,
          tags,
          source: "manual",
        },
      ],
      { listId }
    );

    await audit({
      action: "contact.create",
      entity: "Contact",
      detail: email,
      userId: session.uid,
    });

    if (stats.suppressed > 0) {
      return backWithError(
        "/contacts",
        `${email} steht auf der Sperrliste (Abmeldung oder Zustellfehler) und wurde nicht wieder aufgenommen. Bei „Alle“ suchen und dort freigeben, falls das gewollt ist.`
      );
    }
    if (stats.created > 0) {
      return backWithOk("/contacts", `${email} hinzugefügt.`);
    }
    return backWithOk("/contacts", `${email} war bereits vorhanden und wurde aktualisiert.`);
  } catch (e) {
    return backWithError("/contacts", errorMessage(e));
  }
}
