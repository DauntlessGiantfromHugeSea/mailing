#!/bin/sh
# Prüft VOR dem Start, ob Domain und Server für ein Let's-Encrypt-Zertifikat
# bereit sind. Läuft auf dem Zielserver.
#
#   sh scripts/preflight.sh mailing.rss-fb.com
#
# Grund für dieses Skript: Caddy scheitert bei der Zertifikatsausstellung
# stumm-ish, wenn eine dieser Voraussetzungen fehlt. Die Fehlermeldung im
# Container-Log ist dann schwer zu deuten. Hier wird jede Bedingung einzeln
# geprüft und benannt.

set -u

DOMAIN="${1:-${APP_DOMAIN:-}}"
if [ -z "$DOMAIN" ]; then
  echo "Aufruf: sh scripts/preflight.sh <domain>"
  exit 2
fi

fail=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFEHL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }

echo
echo "Preflight für $DOMAIN"
echo "----------------------------------------------------------"

# --- 1) Öffentliche IP des Servers ---------------------------------------
SERVER_IP=""
for svc in "https://api.ipify.org" "https://ifconfig.me/ip" "https://icanhazip.com"; do
  SERVER_IP=$(curl -4 -s --max-time 8 "$svc" 2>/dev/null | tr -d '[:space:]')
  case "$SERVER_IP" in
    *.*.*.*) break ;;
    *) SERVER_IP="" ;;
  esac
done
if [ -n "$SERVER_IP" ]; then
  ok "öffentliche IP dieses Servers: $SERVER_IP"
else
  warn "öffentliche IP nicht ermittelbar (kein Internetzugang?) — IP-Vergleich wird übersprungen"
fi

# --- 2) DNS-Auflösung ----------------------------------------------------
resolve() {
  if command -v dig >/dev/null 2>&1; then
    dig +short A "$1" 2>/dev/null | grep -E '^[0-9]+\.' | head -1
  elif command -v host >/dev/null 2>&1; then
    host -t A "$1" 2>/dev/null | awk '/has address/{print $4; exit}'
  elif command -v getent >/dev/null 2>&1; then
    getent ahostsv4 "$1" 2>/dev/null | awk '{print $1; exit}'
  fi
}
DNS_IP=$(resolve "$DOMAIN")

# Wildcard-Erkennung: löst ein garantiert nicht existierender Name derselben
# Zone auf dieselbe IP auf, dann greift ein *-Record. Genau das ist bei
# rss-fb.com der Fall (Wildcard auf den all-inkl-Webspace). Der Name "löst
# dann auf", zeigt aber auf den falschen Server — und Let's Encrypt validiert
# gegen diesen falschen Server.
BASE=$(echo "$DOMAIN" | awk -F. '{if (NF>=2) print $(NF-1)"."$NF}')
WILD_IP=$(resolve "zz-preflight-$$-nichtexistent.$BASE")

if [ -z "$DNS_IP" ]; then
  bad "$DOMAIN löst nicht auf — A-Record fehlt noch oder ist nicht propagiert"
  echo "        Anzulegen beim DNS-Anbieter der Zone $BASE:"
  echo "          Typ:  A"
  echo "          Name: $(echo "$DOMAIN" | sed "s/\.$BASE\$//")"
  echo "          Wert: ${SERVER_IP:-<IP dieses Servers>}"
  echo "          TTL:  300"
elif [ -n "$WILD_IP" ] && [ "$WILD_IP" = "$DNS_IP" ]; then
  bad "$DOMAIN löst nur über einen WILDCARD-Record auf ($DNS_IP)"
  echo "        Beweis: zz-preflight-$$-nichtexistent.$BASE löst auf dieselbe IP auf."
  echo "        Es gibt also einen *.$BASE-Record, aber keinen eigenen für"
  echo "        '$(echo "$DOMAIN" | sed "s/\.$BASE\$//")'. Let's Encrypt validiert dann gegen $DNS_IP —"
  echo "        das ist nicht dieser Server, die Ausstellung schlägt fehl."
  echo
  echo "        Lösung: einen EIGENEN A-Record anlegen. Ein spezifischer Record"
  echo "        hat Vorrang vor der Wildcard:"
  echo "          Typ:  A"
  echo "          Name: $(echo "$DOMAIN" | sed "s/\.$BASE\$//")"
  echo "          Wert: ${SERVER_IP:-<IP dieses Servers>}"
  echo "          TTL:  300"
else
  ok "$DOMAIN löst auf $DNS_IP auf (eigener Record, keine Wildcard)"
  if [ -z "$SERVER_IP" ]; then
    bad "IP dieses Servers unbekannt — Abgleich mit dem A-Record nicht möglich"
    echo "        Bitte manuell prüfen: zeigt $DNS_IP auf diesen Server?"
    echo "        Ist das der Fall, kann dieser Punkt ignoriert werden."
  elif [ "$DNS_IP" != "$SERVER_IP" ]; then
    bad "A-Record zeigt auf $DNS_IP, dieser Server ist aber $SERVER_IP"
    echo "        Let's Encrypt validiert gegen $DNS_IP — dort läuft nicht dieser Server."
    echo "        Liegt eine CDN/Proxy-Schicht davor, muss sie für die Ausstellung aus sein."
  else
    ok "A-Record zeigt auf diesen Server"
  fi
fi

# IPv6: ein überzähliger oder falscher AAAA-Record bricht die Ausstellung,
# weil Let's Encrypt IPv6 bevorzugt.
resolve6() {
  if command -v dig >/dev/null 2>&1; then
    dig +short AAAA "$1" 2>/dev/null | grep ':' | head -1
  elif command -v host >/dev/null 2>&1; then
    host -t AAAA "$1" 2>/dev/null | awk '/IPv6 address/{print $5; exit}'
  fi
}
DNS_IP6=$(resolve6 "$DOMAIN")
if [ -n "$DNS_IP6" ]; then
  SERVER_IP6=$(curl -6 -s --max-time 8 https://api6.ipify.org 2>/dev/null | tr -d '[:space:]')
  if [ -n "$SERVER_IP6" ] && [ "$DNS_IP6" = "$SERVER_IP6" ]; then
    ok "AAAA-Record zeigt auf diesen Server ($DNS_IP6)"
  else
    bad "AAAA-Record vorhanden ($DNS_IP6), zeigt aber nicht auf diesen Server"
    echo "        Let's Encrypt bevorzugt IPv6. Diesen Record löschen oder auf"
    echo "        die IPv6 dieses Servers setzen${SERVER_IP6:+ ($SERVER_IP6)}."
  fi
else
  ok "kein AAAA-Record — Validierung läuft über IPv4"
fi

# --- 3) Ports frei bzw. erreichbar --------------------------------------
port_user() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $6; exit}'
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltnp 2>/dev/null | awk -v p=":$1\$" '$4 ~ p {print $7; exit}'
  fi
}
for p in 80 443; do
  who=$(port_user "$p")
  if [ -z "$who" ]; then
    ok "Port $p ist frei — Caddy kann ihn belegen"
  else
    case "$who" in
      *caddy*|*docker*|*mailing*)
        warn "Port $p ist belegt von: $who (evtl. ein früherer Start dieses Stacks)" ;;
      *)
        bad "Port $p ist belegt von: $who"
        echo "        Entweder diesen Dienst stoppen, oder OHNE --profile caddy starten"
        echo "        und den vorhandenen Proxy auf 127.0.0.1:${APP_PORT:-3000} zeigen lassen"
        echo "        (DEPLOY.md, Variante B)." ;;
    esac
  fi
done

# --- 4) Ports von außen erreichbar? -------------------------------------
# Nur als Hinweis: eine Firewall davor sieht man von innen nicht.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  for p in 80 443; do
    if ufw status 2>/dev/null | grep -qE "(^|[[:space:]])$p(/tcp)?([[:space:]]|$).*ALLOW"; then
      ok "ufw erlaubt Port $p"
    else
      bad "ufw ist aktiv, aber Port $p ist nicht freigegeben — 'ufw allow $p/tcp'"
    fi
  done
fi

# --- 5) .env-Konfiguration ----------------------------------------------
if [ -f .env ]; then
  ok ".env vorhanden"
  # shellcheck disable=SC1091
  need() {
    val=$(grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
    if [ -z "$val" ]; then bad ".env: $1 ist nicht gesetzt"; else ok ".env: $1 gesetzt"; fi
  }
  need POSTGRES_PASSWORD
  need FIELD_ENCRYPTION_KEY
  need SESSION_SECRET
  need APP_URL

  key=$(grep -E "^FIELD_ENCRYPTION_KEY=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
  if [ -n "$key" ]; then
    len=$(printf '%s' "$key" | wc -c | tr -d ' ')
    if [ "$len" -ne 64 ]; then
      bad "FIELD_ENCRYPTION_KEY hat $len Zeichen, erwartet sind 64 (openssl rand -hex 32)"
    fi
  fi

  appurl=$(grep -E "^APP_URL=" .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'"'"' ')
  case "$appurl" in
    https://*) ok "APP_URL nutzt HTTPS" ;;
    "") : ;;
    *) bad "APP_URL ist '$appurl' — produktiv muss dort die https://-Adresse stehen (steckt in den Abmeldelinks)" ;;
  esac
  case "$appurl" in
    */) bad "APP_URL endet auf '/' — bitte ohne Slash am Ende" ;;
  esac
else
  bad ".env fehlt — 'cp .env.example .env' und ausfüllen"
fi

echo "----------------------------------------------------------"
if [ "$fail" -eq 0 ]; then
  printf '\033[32mBereit.\033[0m Start mit:  docker compose --profile caddy up -d --build\n\n'
  exit 0
fi
printf '\033[31m%s Punkt(e) offen.\033[0m Bitte oben genannte Punkte beheben.\n\n' "$fail"
exit 1
