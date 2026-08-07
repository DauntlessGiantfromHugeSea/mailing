import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { importReachContacts } from "@/lib/hostingerSync";

/** Kontakte aus Hostinger Reach uebernehmen. */
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/contacts", "Keine Berechtigung.");

  const form = await req.formData();
  const listId = String(form.get("listId") ?? "").trim() || null;

  try {
    const res = await importReachContacts({ listId });
    await audit({
      action: "contacts.reachImport",
      detail: `${res.created} neu, ${res.updated} aktualisiert`,
      userId: session.uid,
    });
    return backWithOk(
      "/contacts",
      `Aus Hostinger Reach übernommen — ${res.created} neu, ${res.updated} aktualisiert` +
        (res.skipped > 0 ? `, ${res.skipped} übersprungen.` : ".")
    );
  } catch (e) {
    return backWithError("/contacts", errorMessage(e));
  }
}
