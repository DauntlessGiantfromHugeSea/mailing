import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

// Legt den ersten Admin an. Idempotent - bei erneutem Lauf wird nur das
// Passwort aktualisiert, falls SEED_ADMIN_PASSWORD gesetzt ist.

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = (process.env.SEED_ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const password = process.env.SEED_ADMIN_PASSWORD ?? "";
  if (password.length < 12 || password === "ChangeMe!2026") {
    console.error("SEED_ADMIN_PASSWORD fehlt, ist kürzer als 12 Zeichen oder das alte Standardpasswort – Seed abgebrochen.");
    process.exit(1);
  }
  const name = process.env.SEED_ADMIN_NAME ?? "Administrator";

  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name, passwordHash, role: "ADMIN", active: true },
    update: { passwordHash, role: "ADMIN", active: true },
  });

  console.log(`Admin bereit: ${user.email}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
