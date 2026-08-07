import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { seeOther, backWithError } from "@/lib/http";

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(form.get("password") ?? "");

  const fail = () => backWithError("/login", "E-Mail oder Passwort ist falsch.");
  if (!email || !password) return fail();

  const user = await prisma.user.findUnique({ where: { email } });
  // Immer hashen, damit die Antwortzeit nichts über die Existenz des Kontos verrät.
  const hash = user?.passwordHash ?? "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv";
  const ok = await bcrypt.compare(password, hash);

  if (!user || !ok) return fail();
  if (!user.active) return backWithError("/login", "Dieses Konto ist deaktiviert.");

  await createSession({ uid: user.id, role: user.role, name: user.name, email: user.email });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ action: "login", entity: "User", entityId: user.id, userId: user.id });

  return seeOther("/dashboard");
}
