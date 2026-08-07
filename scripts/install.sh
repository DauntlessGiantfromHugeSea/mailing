#!/bin/sh
# Erstinstallation auf dem Server. Aus dem geklonten Repo-Verzeichnis ausführen:
#
#   sh scripts/install.sh mailing.rss-fb.com admin@deine-domain.de
#
# Das Skript erkennt selbst, welche der beiden Betriebsarten passt:
#
#   Variante A ("own")    - Ports 80/443 sind frei. Der Stack bringt einen
#                           eigenen Caddy mit, der das Zertifikat holt.
#   Variante B ("behind") - Auf dem Server läuft schon ein Reverse Proxy auf
#                           80/443. Dann startet KEIN eigener Caddy; die App
#                           lauscht auf 127.0.0.1:<APP_PORT> und das Skript
#                           gibt am Ende den Konfigurationsblock aus, der in
#                           den vorhandenen Proxy gehört.
#
# Erzwingen mit:  PROXY_MODE=own|behind sh scripts/install.sh …
# Port wählen:    APP_PORT=3020 sh scripts/install.sh …
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

# Plattenplatz: der Build braucht ein paar GB.
avail_kb=$(df -Pk . | awk 'NR==2{print $4}')
if [ "${avail_kb:-0}" -lt 5242880 ]; then
  note "WARNUNG: nur $((avail_kb / 1024 / 1024)) GB frei. Der Build braucht ca. 3-4 GB."
  note "Platz schaffen mit:  docker image prune -a"
fi

# ------------------------------------------------------- Betriebsart bestimmen
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | awk -v p=":$1\$" 'NR>1 && $4 ~ p {f=1} END{exit !f}'
  else
    netstat -ltn 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {f=1} END{exit !f}'
  fi
}
port_user() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $6; exit}'
  else
    netstat -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $7; exit}'
  fi
}

step "Betriebsart bestimmen"
# Ohne ss/netstat wäre jede Portprüfung ein stilles "frei" - und das Skript
# würde einen eigenen Caddy starten, der dem vorhandenen Proxy Port 80
# wegnehmen will. Deshalb hier hart abbrechen statt raten.
if ! command -v ss >/dev/null 2>&1 && ! command -v netstat >/dev/null 2>&1; then
  die "Weder 'ss' noch 'netstat' vorhanden - belegte Ports wären nicht erkennbar.
       Auf Debian/Ubuntu:  apt-get install -y iproute2
       Oder Betriebsart und Port selbst vorgeben:
         PROXY_MODE=behind APP_PORT=3020 sh scripts/install.sh $DOMAIN"
fi

if [ -n "${PROXY_MODE:-}" ]; then
  note "PROXY_MODE ist vorgegeben: $PROXY_MODE"
elif port_busy 80 || port_busy 443; then
  PROXY_MODE=behind
  note "Port 80/443 ist belegt von: $(port_user 80)$( [ -n "$(port_user 443)" ] && printf ' / %s' "$(port_user 443)")"
  note "=> Variante B: kein eigener Caddy, die App wird hinter den vorhandenen Proxy gehängt."
else
  PROXY_MODE=own
  note "Ports 80/443 sind frei => Variante A: eigener Caddy mit automatischem SSL."
fi

# Freien Port für die App suchen, falls nicht vorgegeben.
if [ -z "${APP_PORT:-}" ]; then
  APP_PORT=3000
  while port_busy "$APP_PORT" && [ "$APP_PORT" -lt 3100 ]; do
    APP_PORT=$((APP_PORT + 1))
  done
fi
if port_busy "$APP_PORT"; then
  die "Port $APP_PORT ist belegt von: $(port_user "$APP_PORT")
       Anderen Port wählen:  APP_PORT=3050 sh scripts/install.sh $DOMAIN"
fi
note "Die App lauscht auf 127.0.0.1:$APP_PORT"

# ------------------------------------------------------------------------ .env
if [ -f .env ]; then
  step ".env ist vorhanden - bleibt unverändert"
  note "Secrets werden nicht neu erzeugt. Ein geänderter FIELD_ENCRYPTION_KEY"
  note "würde alle bereits verschlüsselten Daten unlesbar machen."
  # Vorhandenen Port übernehmen, damit Compose und Proxy-Hinweis zusammenpassen.
  env_port=$(grep -E '^APP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
  if [ -n "$env_port" ]; then
    APP_PORT="$env_port"
    note "APP_PORT aus .env: $APP_PORT"
  fi
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
# Port am Host, nur auf 127.0.0.1 gebunden.
APP_PORT="${APP_PORT}"

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
if ! PROXY_MODE="$PROXY_MODE" APP_PORT="$APP_PORT" sh scripts/preflight.sh "$DOMAIN"; then
  die "Preflight nicht bestanden. Bitte die oben genannten Punkte beheben und erneut starten."
fi

# ----------------------------------------------------------------------- Start
if [ "$PROXY_MODE" = "own" ]; then
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

  step "Stack bauen und starten (dauert beim ersten Mal einige Minuten)"
  RUN_SEED_ON_START=1 docker compose --profile caddy up -d --build

  step "Auf das Zertifikat warten"
  note "Caddy holt es per HTTP-01-Challenge über Port 80."
  ok=0; i=0
  while [ "$i" -lt 40 ]; do
    if docker compose logs caddy 2>/dev/null | grep -q "certificate obtained successfully"; then
      ok=1; break
    fi
    if docker compose logs caddy 2>/dev/null | grep -qE "could not get certificate|failed to obtain certificate"; then
      printf '\n'
      docker compose logs caddy 2>/dev/null | grep -A3 -E "could not get certificate|failed to obtain certificate" | tail -12
      die "Zertifikatsausstellung fehlgeschlagen - siehe Log oben.
       Häufigste Ursache: Port 80 ist von außen nicht erreichbar (Firewall)."
    fi
    i=$((i+1)); printf '.'; sleep 3
  done
  printf '\n'
  [ "$ok" -eq 1 ] && note "Zertifikat ausgestellt" \
    || note "Noch kein Erfolg im Log - weiter beobachten: docker compose logs -f caddy"
else
  step "Stack bauen und starten (ohne eigenen Caddy, dauert beim ersten Mal einige Minuten)"
  RUN_SEED_ON_START=1 docker compose up -d --build
fi

# ------------------------------------------------------------------- Status
step "Status"
docker compose ps

step "Antwortet die App intern?"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "http://127.0.0.1:${APP_PORT}/login" || echo "000")
if [ "$code" = "200" ]; then
  note "http://127.0.0.1:${APP_PORT}/login -> 200"
else
  note "http://127.0.0.1:${APP_PORT}/login -> $code"
  note "Bei 000/502 einen Moment warten; Logs: docker compose logs -f app"
fi

step "Läuft der Worker?"
docker compose logs worker 2>/dev/null | tail -3
note "Ohne den Worker werden Kampagnen geplant, aber nie versendet."

# --------------------------------------------------- Abschluss je Betriebsart
if [ "$PROXY_MODE" = "behind" ]; then
  # Wo liegt die Konfiguration des vorhandenen Proxys?
  CADDYFILE=""
  for f in /etc/caddy/Caddyfile /usr/local/etc/caddy/Caddyfile; do
    [ -f "$f" ] && CADDYFILE="$f" && break
  done

  cat <<EOF

====================================================================
NOCH EIN SCHRITT: die Domain im vorhandenen Reverse Proxy eintragen

Der Stack läuft, ist aber von außen noch nicht erreichbar. Der Proxy auf
Port 80/443 weiß noch nichts von ${DOMAIN}.

Diesen Block in die Caddy-Konfiguration aufnehmen:

${DOMAIN} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:${APP_PORT}
}

EOF

  if [ -n "$CADDYFILE" ]; then
    cat <<EOF
Gefundene Konfiguration: ${CADDYFILE}

Mit Backup anfügen und neu laden:

  cp ${CADDYFILE} ${CADDYFILE}.bak-\$(date +%F)
  cat >> ${CADDYFILE} <<'CADDY'

${DOMAIN} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:${APP_PORT}
}
CADDY
  caddy validate --config ${CADDYFILE} && systemctl reload caddy

EOF
  else
    cat <<EOF
Die Caddy-Konfiguration wurde nicht an den üblichen Stellen gefunden.
Suchen mit:   systemctl cat caddy | grep -i config
              find /etc -name Caddyfile 2>/dev/null

EOF
  fi

  cat <<EOF
Danach prüfen:

  curl -I https://${DOMAIN}/login

Caddy holt das Zertifikat beim ersten Aufruf automatisch.
====================================================================

Weitere Schritte:

  1. RUN_SEED_ON_START in .env auf 0 setzen bzw. die Zeile löschen - sonst
     wird das Admin-Passwort bei jedem Neustart zurückgesetzt.
  2. FIELD_ENCRYPTION_KEY aus .env an einen sicheren Ort sichern.
  3. In der App: Absender anlegen -> "testen" -> Kontakte importieren
     -> Kampagne anlegen.

Logs:     docker compose logs -f app
          docker compose logs -f worker
Update:   git pull && docker compose up -d --build
EOF
else
  cat <<EOF

--------------------------------------------------------------------
Fertig. Nächste Schritte:

  1. https://${DOMAIN} öffnen und anmelden
     (Zugangsdaten stehen in .env: SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD)
  2. RUN_SEED_ON_START in .env auf 0 setzen bzw. die Zeile löschen.
  3. FIELD_ENCRYPTION_KEY aus .env an einen sicheren Ort sichern.
  4. In der App: Absender anlegen -> "testen" -> Kontakte importieren
     -> Kampagne anlegen.

Logs:     docker compose logs -f app
          docker compose logs -f worker
Update:   git pull && docker compose --profile caddy up -d --build
--------------------------------------------------------------------
EOF
fi
