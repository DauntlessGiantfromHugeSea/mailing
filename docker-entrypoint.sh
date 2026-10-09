#!/bin/sh
set -e

# Schema anlegen/aktualisieren. Nur die App-Rolle macht das, damit App und
# Worker nicht gleichzeitig migrieren.
case "$*" in
  *"next start"*)
    echo "[entrypoint] Datenbankschema abgleichen…"
    npx prisma db push --skip-generate --accept-data-loss

    if [ "${RUN_SEED_ON_START:-0}" = "1" ]; then
      # Nie mit leerem, kurzem oder bekanntem Standardpasswort seeden
      # (Sicherheits-Audit 2026-10).
      case "${SEED_ADMIN_PASSWORD:-}" in
        ""|"ChangeMe!2026")
          echo "[entrypoint] FEHLER: RUN_SEED_ON_START=1, aber SEED_ADMIN_PASSWORD ist leer oder das Standardpasswort. Seed übersprungen." >&2
          ;;
        *)
      if [ "${#SEED_ADMIN_PASSWORD}" -lt 12 ]; then
        echo "[entrypoint] FEHLER: SEED_ADMIN_PASSWORD muss mindestens 12 Zeichen haben. Seed übersprungen." >&2
      else
      echo "[entrypoint] Seed läuft…"
      npx tsx prisma/seed.ts || node -e "
        const bcrypt = require('bcryptjs');
        const { PrismaClient } = require('@prisma/client');
        const p = new PrismaClient();
        (async () => {
          const email = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
          const hash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD, 10);
          await p.user.upsert({
            where: { email },
            create: { email, name: process.env.SEED_ADMIN_NAME || 'Administrator', passwordHash: hash, role: 'ADMIN', active: true },
            update: { passwordHash: hash, role: 'ADMIN', active: true },
          });
          console.log('Admin bereit: ' + email);
          await p.\$disconnect();
        })().catch((e) => { console.error(e); process.exit(1); });
      "
      fi
          ;;
      esac
    fi
    ;;
  *)
    # Worker: kurz warten, damit die App das Schema anlegen kann.
    echo "[entrypoint] Worker startet…"
    sleep 5
    ;;
esac

exec "$@"
