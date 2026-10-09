import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { seeOther, backWithError } from "@/lib/http";
import { localLoginEnabled } from "@/lib/authMicrosoft";

// Gültiger Kosten-10-Hash eines Zufallswerts, einmal beim Laden erzeugt.
const DUMMY_HASH = bcrypt.hashSync(randomBytes(24).toString("hex"), 10);

export async function POST(req: Request): Promise<Response> {
  // Der Schalter muss auch hier greifen, nicht nur im Formular: sonst bliebe
  // der Endpunkt trotz abgeschalteter Passwortanmeldung direkt aufrufbar.
  if (!localLoginEnabled()) {
    return backWithError("/login", "Die Anmeldung mit Passwort ist deaktiviert.");
  }

  const form = await req.formData();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(form.get("password") ?? "");

  const fail = () => backWithError("/login", "E-Mail oder Passwort ist falsch.");
  if (!email || !password) return fail();

  const user = await prisma.user.findUnique({ where: { email } });
  // Immer einen echten bcrypt-Vergleich rechnen, damit die Antwortzeit nichts
  // über die Existenz des Kontos verrät. Der alte Platzhalter war kein gültiger
  // Hash (66 statt 60 Zeichen) -> bcryptjs brach sofort ab (Sicherheits-Audit 2026-10).
  const stored = user?.passwordHash ?? "";
  const valid = stored.length === 60 && stored.startsWith("$2");
  const ok = (await bcrypt.compare(password, valid ? stored : DUMMY_HASH)) && valid;

  if (!user || !ok) return fail();
  if (!user.active) return backWithError("/login", "Dieses Konto ist deaktiviert.");

  await createSession({ uid: user.id, role: user.role, name: user.name, email: user.email });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ action: "login", entity: "User", entityId: user.id, userId: user.id });

  return seeOther("/dashboard");
}
