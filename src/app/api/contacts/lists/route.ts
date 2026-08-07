import { prisma } from "@/lib/db";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!canEdit(session)) return backWithError("/contacts", "Keine Berechtigung.");

  const form = await req.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return backWithError("/contacts", "Listenname fehlt.");

  try {
    await prisma.contactList.create({ data: { name } });
    return backWithOk("/contacts", `Liste „${name}“ angelegt.`);
  } catch (e) {
    return backWithError("/contacts", errorMessage(e));
  }
}
