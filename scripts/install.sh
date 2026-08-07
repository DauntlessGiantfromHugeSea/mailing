#!/bin/sh
# Erstinstallation auf dem Server. Aus dem geklonten Repo-Verzeichnis ausführen:
#
#   sh scripts/install.sh mailing.rss-fb.com admin@deine-domain.de
#
# Das Skript
#   - prüft, ob Docker und Compose v2 vorhanden sind,
#   - legt .env an und erzeugt die Secrets (nur wenn .env noch fehlt),
#   - führt den Preflight aus (DNS, Wildcard, Ports),
#   - startet den Stack und wartet auf das Zertifikat.
#
# Mehrfaches Ausführen ist unschädlich: eine vorhandene .env wird NICHT
# überschrieben, damit der FIELD_ENCRYPTION_KEY nicht verloren geht - mit ihm
# wären alle verschlüsselten Daten unlesbar.

set -eu

DOMAIN="${1:-}"
ADMIN_EMAIL="${2:-}"

die() { printf '\n\033[31mAbbruch:\033[0m %s\n\n' "$1" >&2; exit 1; }
step() { printf '\n\033[36m==>\033[0m %s\n' "$1"; }
note() { printf '    %s\n' "$1"; }

[ -n "$DOMAIN" ] || die "Aufruf: sh scripts/install.sh <domain> [admin-email]
       Beispiel: sh scripts/install.sh mailing.rss-fb.com admin@example.de"
[ -f docker-compose.yml ] || die "Bitte aus dem Repo-Verzeichnis ausführen (docker-compose.yml nicht gefunden)."

# ------------------------------------------------------------- Voraussetzungen
step "Voraussetzungen prüfen"

command -v docker >/dev/null 2>&1 || die "Docker ist nicht installiert.
       Installation:  curl -fsSL https://get.docker.com | sh"

if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 fehlt (das alte 'docker-compose' genügt nicht).
       Auf Debian/Ubuntu:  apt-get install -y docker-compose-plugin"
fi

docker info >/dev/null 2>&1 || die "Docker-Daemon läuft nicht oder der aktuelle Benutzer darf ihn nicht ansprechen.
       Versuche:  systemctl start docker    (bzw. das Skript mit sudo ausführen)"

note "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') bereit"

command -v openssl >/dev/null 2>&1 || die "openssl fehlt - wird für die Secrets gebraucht.
       Auf Debian/Ubuntu:  apt-get install -y openssl"

# ------------------------------------------------------------------------ .env
if [ -f .env ]; then
  step ".env ist vorhanden - bleibt unverändert"
  note "Secrets werden nicht neu erzeugt. Ein geänderter FIELD_ENCRYPTION_KEY"
  note "würde alle bereits verschlüsselten Daten unlesbar machen."
else
  step ".env anlegen und Secrets erzeugen"

  if [ -z "$ADMIN_EMAIL" ]; then
    printf '    E-Mail-Adresse für den Admin-Zugang: '
    read -r ADMIN_EMAIL
    [ -n "$ADMIN_EMAIL" ] || die "Keine Admin-Adresse angegeben."
  fi

  ADMIN_PW=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)

  umask 077
  cat > .env <<EOF
# Erzeugt von scripts/install.sh am $(date -u '+%Y-%m-%d %H:%M UTC')

# --- Öffentliche Adresse ---
APP_URL="https://${DOMAIN}"
APP_DOMAIN="${DOMAIN}"
APP_PORT="3000"

# --- Postgres ---
POSTGRES_USER="mailing"
POSTGRES_DB="mailing"
POSTGRES_PASSWORD="$(openssl rand -hex 24)"

# --- Secrets ---
# ACHTUNG: FIELD_ENCRYPTION_KEY sichern! Ohne ihn sind Kontaktdaten,
# SMTP-Passwörter und das API-Token auch aus einem Backup nicht lesbar.
FIELD_ENCRYPTION_KEY="$(openssl rand -hex 32)"
SESSION_SECRET="$(openssl rand -hex 48)"
CRON_SECRET="$(openssl rand -hex 32)"

# --- Erster Admin ---
SEED_ADMIN_EMAIL="${ADMIN_EMAIL}"
SEED_ADMIN_PASSWORD="${ADMIN_PW}"
SEED_ADMIN_NAME="Administrator"

# --- Hostinger-API (optional) ---
# Kann auch später in der App unter "Einstellungen" hinterlegt werden.
HOSTINGER_API_TOKEN=""
EOF

  note ".env geschrieben (Rechte 600)"
  printf '\n    \033[33mZugangsdaten für den ersten Login:\033[0m\n'
  printf '      E-Mail:   %s\n' "$ADMIN_EMAIL"
  printf '      Passwort: %s\n' "$ADMIN_PW"
  printf '    (steht auch in .env unter SEED_ADMIN_PASSWORD)\n'
fi

# ------------------------------------------------------------------- Preflight
step "Preflight (DNS, Wildcard, Ports)"
if ! sh scripts/preflight.sh "$DOMAIN"; then
  die "Preflight nicht bestanden. Bitte die oben genannten Punkte beheben und erneut starten.
       Solange DNS oder Ports nicht stimmen, kann Let's Encrypt kein Zertifikat ausstellen -
       und wiederholte Fehlversuche laufen ins Rate Limit (5 pro Stunde und Domain)."
fi

# ------------------------------------------------------------- Caddyfile prüfen
step "Caddyfile prüfen"
# Ausgabe in eine Variable, NICHT durch eine Pipe: bei `cmd | tail` wäre der
# Exit-Status der von tail (immer 0) und ein fehlerhaftes Caddyfile fiele
# durch. --profile caddy ist nötig, weil der Dienst hinter dem Profil liegt.
if caddy_out=$(docker compose --profile caddy run --rm --no-deps caddy \
      caddy validate --config /etc/caddy/Caddyfile 2>&1); then
  note "Caddyfile ist gültig"
else
  printf '%s\n' "$caddy_out" | tail -15
  die "Caddyfile ist fehlerhaft - Caddy würde nicht starten (Ausgabe oben)."
fi

# ----------------------------------------------------------------------- Start
step "Stack bauen und starten (dauert beim ersten Mal einige Minuten)"
RUN_SEED_ON_START=1 docker compose --profile caddy up -d --build

step "Auf das Zertifikat warten"
note "Caddy holt es per HTTP-01-Challenge über Port 80."
ok=0
i=0
while [ "$i" -lt 40 ]; do
  if docker compose logs caddy 2>/dev/null | grep -q "certificate obtained successfully"; then
    ok=1; break
  fi
  if docker compose logs caddy 2>/dev/null | grep -qE "could not get certificate|failed to obtain certificate"; then
    printf '\n'
    docker compose logs caddy 2>/dev/null | grep -A3 -E "could not get certificate|failed to obtain certificate" | tail -12
    die "Zertifikatsausstellung fehlgeschlagen - siehe Log oben.
       Häufigste Ursache: Port 80 ist von außen nicht erreichbar (Firewall/Security Group)."
  fi
  i=$((i+1))
  printf '.'
  sleep 3
done
printf '\n'

[ "$ok" -eq 1 ] && note "Zertifikat ausgestellt" || note "Noch kein Erfolg im Log - weiter beobachten mit: docker compose logs -f caddy"

# ------------------------------------------------------------------ Abschluss
step "Status"
docker compose ps

step "Erreichbarkeit"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://${DOMAIN}/login" || echo "000")
if [ "$code" = "200" ]; then
  printf '    \033[32mhttps://%s/login antwortet mit 200\033[0m\n' "$DOMAIN"
else
  printf '    \033[33mhttps://%s/login antwortet mit %s\033[0m\n' "$DOMAIN" "$code"
  note "Bei 000/502 kurz warten und erneut prüfen - die App braucht einen Moment."
fi

step "Läuft der Worker?"
docker compose logs worker 2>/dev/null | tail -3
note "Ohne den Worker werden Kampagnen geplant, aber nie versendet."

cat <<EOF

--------------------------------------------------------------------
Fertig. Nächste Schritte:

  1. https://${DOMAIN} öffnen und anmelden
     (Zugangsdaten stehen in .env: SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)

  2. RUN_SEED_ON_START in .env auf 0 setzen bzw. weglassen - sonst wird das
     Admin-Passwort bei jedem Neustart aus der .env zurückgesetzt.

  3. FIELD_ENCRYPTION_KEY aus .env an einen sicheren Ort sichern.

  4. In der App: Absender anlegen -> "testen" -> Kontakte importieren
     -> Kampagne anlegen.

Logs:     docker compose logs -f app
          docker compose logs -f worker
Update:   git pull && docker compose --profile caddy up -d --build
--------------------------------------------------------------------
EOF
