import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { csvToContacts, parseCsv, upsertContacts } from "@/lib/contacts";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/contacts", "Keine Berechtigung.");

  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return backWithError("/contacts", "Bitte eine CSV-Datei auswählen.");
    }
    if (file.size > MAX_BYTES) {
      return backWithError("/contacts", "Die Datei ist größer als 8 MB.");
    }

    const text = await file.text();
    const { header, rows } = parseCsv(text);
    if (header.length === 0 || rows.length === 0) {
      return backWithError("/contacts", "Die CSV enthält keine Datenzeilen.");
    }

    const { contacts, unmapped } = csvToContacts(header, rows);
    if (contacts.length === 0) {
      return backWithError(
        "/contacts",
        `Keine E-Mail-Spalte erkannt. Gefundene Spalten: ${header.join(", ")}`
      );
    }

    // Zielliste bestimmen bzw. neu anlegen.
    let listId = String(form.get("listId") ?? "").trim() || null;
    const newListName = String(form.get("newListName") ?? "").trim();
    if (newListName) {
      const list = await prisma.contactList.create({
        data: { name: newListName, description: `Import aus ${file.name}` },
      });
      listId = list.id;
    }

    const stats = await upsertContacts(contacts, { listId });

    await audit({
      action: "contacts.import",
      entity: "ContactList",
      entityId: listId ?? undefined,
      detail: `${file.name}: +${stats.created} neu, ${stats.updated} aktualisiert`,
      userId: session.uid,
    });

    const parts = [`${stats.created} neu`, `${stats.updated} aktualisiert`];
    if (stats.suppressed > 0) parts.push(`${stats.suppressed} übersprungen (Sperrliste)`);
    if (stats.invalid.length > 0) parts.push(`${stats.invalid.length} ungültig`);
    if (unmapped.length > 0) parts.push(`Zusatzfelder: ${unmapped.join(", ")}`);

    return backWithOk("/contacts", `Import abgeschlossen — ${parts.join(", ")}.`);
  } catch (e) {
    return backWithError("/contacts", errorMessage(e));
  }
}
