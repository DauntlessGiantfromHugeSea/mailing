#!/bin/sh
# Prüft die Microsoft-Entra-Konfiguration, ohne dass sich jemand anmelden muss.
#
#   sh scripts/check-microsoft.sh
#
# Hintergrund: Verzeichnis-ID (Mandant) und Anwendungs-ID (Client) stehen im
# Azure-Portal direkt untereinander und sehen beide wie eine GUID aus. Werden
# sie verwechselt, antwortet Microsoft erst beim Anmeldeversuch mit
# "AADSTS90002: Tenant not found" - und die Meldung nennt nicht, dass da eine
# Client-ID steht. Dieses Skript findet das vorher.

set -u

ENV_FILE="${ENV_FILE:-.env}"
[ -f "$ENV_FILE" ] || { echo "Keine $ENV_FILE gefunden - bitte im Repo-Verzeichnis ausführen."; exit 2; }

val() {
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- \
    | sed 's/^["'"'"']//;s/["'"'"']$//' | tr -d '<>' | tr -d '[:space:]'
}

fail=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFEHL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
info() { printf '        %s\n' "$1"; }

TENANT=$(val MICROSOFT_TENANT_ID)
CLIENT=$(val MICROSOFT_CLIENT_ID)
SECRET=$(val MICROSOFT_CLIENT_SECRET)
DOMAINS=$(val MICROSOFT_ALLOWED_DOMAINS)
APPURL=$(val APP_URL)

echo
echo "Microsoft-Entra-Konfiguration"
echo "----------------------------------------------------------"

if [ -z "$TENANT" ] && [ -z "$CLIENT" ] && [ -z "$SECRET" ]; then
  echo "  Microsoft-Anmeldung ist nicht konfiguriert (alle drei Werte leer)."
  echo "  Das ist in Ordnung - dann gilt nur die Anmeldung mit Passwort."
  echo
  exit 0
fi

GUID='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

# --- Format ---------------------------------------------------------------
echo "$TENANT" | grep -qE "$GUID" && ok "MICROSOFT_TENANT_ID hat GUID-Format" \
  || bad "MICROSOFT_TENANT_ID ist keine GUID: '$TENANT'"
echo "$CLIENT" | grep -qE "$GUID" && ok "MICROSOFT_CLIENT_ID hat GUID-Format" \
  || bad "MICROSOFT_CLIENT_ID ist keine GUID: '$CLIENT'"

if [ -n "$TENANT" ] && [ "$TENANT" = "$CLIENT" ]; then
  bad "Verzeichnis-ID und Anwendungs-ID sind identisch"
  info "Das sind zwei verschiedene Werte. Im Portal auf der Übersichtsseite"
  info "der App-Registrierung stehen sie untereinander."
fi

[ ${#SECRET} -ge 8 ] && ok "MICROSOFT_CLIENT_SECRET ist gesetzt (${#SECRET} Zeichen)" \
  || bad "MICROSOFT_CLIENT_SECRET fehlt oder ist zu kurz - gebraucht wird die Spalte „Wert“, nicht die „Geheimnis-ID“"

# --- Existiert der Tenant wirklich? --------------------------------------
discovery() {
  curl -sS --max-time 20 "https://login.microsoftonline.com/$1/v2.0/.well-known/openid-configuration" 2>/dev/null
}
issuer_of() {
  discovery "$1" | grep -o '"issuer":"[^"]*"' | head -1 \
    | sed 's|.*login.microsoftonline.com/||;s|/v2.0"||'
}

if [ -n "$TENANT" ]; then
  real=$(issuer_of "$TENANT")
  if [ -n "$real" ]; then
    ok "Verzeichnis existiert bei Microsoft"
  else
    bad "Microsoft kennt dieses Verzeichnis nicht: $TENANT"
    info "Häufigste Ursache: hier steht die Anwendungs-ID statt der Verzeichnis-ID."
    info ""
    info "Die richtige Verzeichnis-ID lässt sich über eine Mail-Domain finden:"
    for d in $(echo "$DOMAINS" | tr ',' ' ') ; do
      [ -n "$d" ] || continue
      found=$(issuer_of "$d")
      [ -n "$found" ] && info "  $d  ->  $found" || info "  $d  ->  kein Microsoft-Tenant"
    done
    info ""
    info "Oder im Portal: Microsoft Entra ID -> Übersicht -> Mandanten-ID."
  fi
fi

# --- Domain-Allowlist gegen den Tenant prüfen ---------------------------
if [ -n "$DOMAINS" ] && [ -n "$TENANT" ]; then
  for d in $(echo "$DOMAINS" | tr ',' ' '); do
    [ -n "$d" ] || continue
    t=$(issuer_of "$d")
    if [ -z "$t" ]; then
      bad "MICROSOFT_ALLOWED_DOMAINS enthält '$d' - dazu gibt es keinen Microsoft-Tenant"
      info "Konten dieser Domain kann es nicht geben; der Eintrag ist wirkungslos."
    elif [ "$t" != "$TENANT" ]; then
      bad "'$d' gehört zu Verzeichnis $t, konfiguriert ist aber $TENANT"
    else
      ok "Domain '$d' gehört zu diesem Verzeichnis"
    fi
  done
fi

# --- Redirect-URI --------------------------------------------------------
if [ -n "$APPURL" ]; then
  case "$APPURL" in
    https://*) : ;;
    *) bad "APP_URL ist '$APPURL' - für Microsoft muss die öffentliche https-Adresse dort stehen" ;;
  esac
  case "$APPURL" in
    */) bad "APP_URL endet auf '/' - bitte ohne Slash am Ende" ;;
  esac
  printf '\n  In der App-Registrierung muss unter Authentifizierung -> Web\n'
  printf '  genau diese Redirect-URI stehen:\n\n'
  printf '      %s/api/auth/microsoft/callback\n\n' "${APPURL%/}"
fi

echo "----------------------------------------------------------"
if [ "$fail" -eq 0 ]; then
  printf '\033[32mKonfiguration plausibel.\033[0m Der Anmeldeversuch kann losgehen.\n\n'
  exit 0
fi
printf '\033[31m%s Punkt(e) offen.\033[0m\n\n' "$fail"
exit 1
