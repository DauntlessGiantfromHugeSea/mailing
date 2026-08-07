#!/bin/sh
set -e

# Schema anlegen/aktualisieren. Nur die App-Rolle macht das, damit App und
# Worker nicht gleichzeitig migrieren.
case "$*" in
  *"next start"*)
    echo "[entrypoint] Datenbankschema abgleichen…"
    npx prisma db push --skip-generate --accept-data-loss

    if [ "${RUN_SEED_ON_START:-0}" = "1" ]; then
      echo "[entrypoint] Seed läuft…"
      npx tsx prisma/seed.ts 2>/dev/null || node -e "
        const bcrypt = require('bcryptjs');
        const { PrismaClient } = require('@prisma/client');
        const p = new PrismaClient();
        (async () => {
          const email = (process.env.SEED_ADMIN_EMAIL || 'admin@example.com').toLowerCase();
          const hash = await bcrypt.hash(process.env.SEED_ADMIN_PASSWORD || 'ChangeMe!2026', 10);
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
  *)
    # Worker: kurz warten, damit die App das Schema anlegen kann.
    echo "[entrypoint] Worker startet…"
    sleep 5
    ;;
esac

exec "$@"
