# Deployment auf `mailing.rss-fb.com`

Ziel: Docker-Stack auf dem eigenen Server, erreichbar unter
`https://mailing.rss-fb.com` mit automatisch erneuertem Let's-Encrypt-Zertifikat.

Der Stack besteht aus vier Containern:

| Container | Aufgabe |
|---|---|
| `mailing-db` | Postgres 16 |
| `mailing-app` | Next.js, lauscht nur auf `127.0.0.1:3000` |
| `mailing-worker` | Versand-Prozess — **ohne ihn geht keine Mail raus** |
| `mailing-caddy` | Reverse Proxy + SSL (nur bei Variante A) |

---

## Schritt 1 — DNS-Record bei all-inkl anlegen

**Das muss von Hand passieren und zuerst.** Die Domain liegt bei all-inkl; deren
KAS hat keine von diesem Tool nutzbare API.

### ⚠️ Wichtig: es gibt bereits eine Wildcard

Bei der Prüfung der Zone hat sich gezeigt:

```
rss-fb.com                                  -> 85.13.166.232
mailing.rss-fb.com                          -> 85.13.166.232
garantiert-nicht-existent-xyz789.rss-fb.com -> 85.13.166.232   ← auch das!
```

Es existiert also ein **Wildcard-Record `*.rss-fb.com`**, der auf den
all-inkl-Webspace (`85.13.166.232`) zeigt. `mailing.rss-fb.com` löst damit
**scheinbar schon auf** — aber auf den falschen Server.

Das ist die Falle: Let's Encrypt validiert gegen `85.13.166.232`, dort läuft
nicht der eigene Server, und die Zertifikatsausstellung schlägt fehl. Der
Fehler sieht dann aus wie ein Caddy-Problem, ist aber ein DNS-Problem.

**Es genügt nicht, „nichts zu tun, weil es ja auflöst“ — es braucht einen
eigenen A-Record.** Ein spezifischer Record hat in DNS Vorrang vor der Wildcard.

### Anzulegen

IP des Zielservers ermitteln (auf dem Server ausführen):

```bash
curl -4 https://api.ipify.org; echo
```

Dann im **all-inkl KAS** in den **DNS-Einstellungen von `rss-fb.com`**:

| Feld | Wert |
|---|---|
| Typ | `A` |
| Name | `mailing` |
| Wert | die IP von oben |
| TTL | `300` |

> Die Menüpunkte heißen je nach KAS-Version etwas anders („Domain →
> DNS-Einstellungen“ bzw. über die Domainverwaltung). Gesucht ist die Stelle, an
> der sich einzelne Resource Records eintragen lassen — **nicht** „Subdomain
> anlegen“, denn das würde `mailing` auf den all-inkl-Webspace zeigen, also
> genau den Zustand herstellen, der hier das Problem ist.
>
> Ebenfalls prüfen: existiert ein `AAAA`-Record (IPv6) für `mailing` oder eine
> IPv6-Wildcard, dann löschen oder auf die IPv6 des Servers setzen. Let's Encrypt
> bevorzugt IPv6 — ein falscher `AAAA` bricht die Ausstellung, selbst wenn der
> `A`-Record stimmt.

Propagation prüfen — und zwar so, dass die Wildcard auffällt:

```bash
dig +short A mailing.rss-fb.com                          # soll: eigene Server-IP
dig +short A zufall-test-123.rss-fb.com                  # zeigt die Wildcard-IP
```

Erst weitermachen, wenn die beiden **unterschiedliche** IPs liefern und die
erste die eigene Server-IP ist. `scripts/preflight.sh` (Schritt 3) prüft genau
das automatisch.

---

## Der kurze Weg

Steht der DNS-Record (Schritt 1) und ist Docker auf dem Server installiert,
genügen drei Befehle:

```bash
git clone https://github.com/DauntlessGiantfromHugeSea/mailing.git
cd mailing && git checkout claude/randomized-email-sender-441ygi
sh scripts/install.sh mailing.rss-fb.com admin@deine-domain.de
```

`install.sh` erzeugt die `.env` samt Secrets, führt den Preflight aus, prüft das
Caddyfile, baut und startet den Stack und wartet auf das Zertifikat. Am Ende
stehen die Zugangsdaten für den ersten Login auf dem Bildschirm.

Mehrfaches Ausführen ist unschädlich: eine vorhandene `.env` wird **nicht**
überschrieben — sonst wäre der `FIELD_ENCRYPTION_KEY` weg und mit ihm der Zugang
zu allen verschlüsselten Daten.

Die folgenden Schritte beschreiben dasselbe von Hand — nützlich zum Verstehen
oder wenn das Skript irgendwo abbricht.

---

## Schritt 2 — Code und Konfiguration auf den Server

```bash
git clone https://github.com/DauntlessGiantfromHugeSea/mailing.git
cd mailing
git checkout claude/randomized-email-sender-441ygi
cp .env.example .env
```

Secrets erzeugen und in `.env` eintragen:

```bash
echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
echo "FIELD_ENCRYPTION_KEY=$(openssl rand -hex 32)"   # genau 64 Hex-Zeichen
echo "SESSION_SECRET=$(openssl rand -hex 48)"
echo "CRON_SECRET=$(openssl rand -hex 32)"            # optional
```

In `.env` müssen mindestens stehen:

```bash
POSTGRES_PASSWORD="…"
FIELD_ENCRYPTION_KEY="…"          # 64 Hex-Zeichen
SESSION_SECRET="…"
APP_URL="https://mailing.rss-fb.com"
APP_DOMAIN="mailing.rss-fb.com"
SEED_ADMIN_EMAIL="deine@adresse.de"
SEED_ADMIN_PASSWORD="…"
```

> ⚠️ **`FIELD_ENCRYPTION_KEY` sichern.** Damit sind Kontaktdaten, SMTP-Passwörter
> und das API-Token verschlüsselt. Geht der Schlüssel verloren, sind diese
> Daten unlesbar — auch aus einem Datenbank-Backup.
>
> ⚠️ **`APP_URL` muss die öffentliche HTTPS-Adresse sein.** Der Wert landet in
> den Abmeldelinks jeder versendeten Mail. Steht dort `localhost`, funktioniert
> die Abmeldung für die Empfänger nicht.

---

## Schritt 3 — Preflight

```bash
sh scripts/preflight.sh mailing.rss-fb.com
```

Prüft DNS-Auflösung, **Wildcard-Erkennung**, IP-Übereinstimmung (v4 und v6),
freie Ports 80/443, ufw-Regeln und die `.env`. Erst weitermachen, wenn alles
grün ist — sonst scheitert die Zertifikatsausstellung und die Ursache ist im
Container-Log schwer zu erkennen.

Ist `dig` nicht installiert, fällt das Skript auf `host` bzw. `getent` zurück.
Für die volle Prüfung (inkl. IPv6) empfiehlt sich:

```bash
apt-get install -y dnsutils     # Debian/Ubuntu
```

Zusätzlich das Caddyfile prüfen, bevor der Proxy das erste Mal startet:

```bash
docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile
```

---

## Schritt 4a — Variante A: mit eigenem Caddy (Standard)

Passend, wenn auf dem Server **noch nichts** auf Port 80/443 läuft.

```bash
RUN_SEED_ON_START=1 docker compose --profile caddy up -d --build
```

Der erste Start dauert einige Minuten (Image-Build). Danach:

```bash
docker compose ps
docker compose logs -f caddy   # Zertifikatsausstellung beobachten
```

Erwartete Zeile im Caddy-Log: `certificate obtained successfully`.

Sobald es läuft, `RUN_SEED_ON_START` in `.env` wieder auf `0` setzen (oder die
Zeile löschen) — sonst wird das Admin-Passwort bei jedem Neustart aus der `.env`
zurückgesetzt.

### Schritt 4b — Variante B: vorhandener Reverse Proxy

Passend, wenn auf dem Server schon ein Webserver auf 80/443 läuft — z. B. der
`fbe-caddy` aus dem Teilnahmemanagement-Setup. Dann **ohne** das Caddy-Profil
starten:

```bash
RUN_SEED_ON_START=1 docker compose up -d --build
```

Die App hängt dann auf `127.0.0.1:3000`. Im vorhandenen Proxy ergänzen:

**Caddy:**

```caddyfile
mailing.rss-fb.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
```

Danach `caddy reload` bzw. den Proxy-Container neu laden. Läuft der vorhandene
Caddy selbst im Docker, erreicht er `127.0.0.1` **nicht** — dann stattdessen
beide Stacks in ein gemeinsames Netzwerk legen und `reverse_proxy mailing-app:3000`
verwenden.

**nginx:**

```nginx
server {
    listen 443 ssl http2;
    server_name mailing.rss-fb.com;

    # certbot --nginx -d mailing.rss-fb.com
    ssl_certificate     /etc/letsencrypt/live/mailing.rss-fb.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/mailing.rss-fb.com/privkey.pem;

    client_max_body_size 10m;   # für den CSV-Import

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## Schritt 5 — Funktion prüfen

```bash
# Zertifikat und Erreichbarkeit
curl -I https://mailing.rss-fb.com/login

# Läuft der Worker? (ohne ihn wird nichts versendet)
docker compose logs worker | tail -20
# erwartet: "[worker …] gestartet"

# Admin wurde angelegt?
docker compose logs app | grep -i "Admin bereit"
```

Dann im Browser `https://mailing.rss-fb.com` öffnen und mit
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` anmelden.

---

## Schritt 6 — Einrichtung in der App

1. **Einstellungen** → Hostinger-API-Token eintragen, „Verbindung testen“
   *(optional — ohne Token entfallen nur Postfach-Import, DNS-Check und
   Log-Abgleich)*
2. **Absender** → Postfach anlegen, danach **„testen“** klicken
3. **Kontakte** → CSV importieren
4. **Kampagnen** → anlegen, Taktung einstellen, starten

### Hinweis zu den Absender-Postfächern

Der Versand läuft über SMTP und ist **nicht an Hostinger gebunden** — `smtpHost`
ist pro Absender frei einstellbar. Da die Domain bei all-inkl liegt, kann ein
all-inkl-Postfach genauso verwendet werden:

| Feld | all-inkl | Hostinger |
|---|---|---|
| SMTP-Server | `w0XXXXXX.kasserver.com` | `smtp.hostinger.com` |
| Port | `465` (SSL) | `465` (SSL) |
| Benutzer | Postfach-Login aus dem KAS | die Mailadresse |

Wichtig für die Zustellbarkeit: **SPF und DKIM müssen zu dem Anbieter passen,
über den tatsächlich versendet wird.** Wird über all-inkl versendet, gehört der
all-inkl-SPF in die DNS-Zone, nicht der von Hostinger. Beides gleichzeitig ohne
Grund einzutragen schwächt die Authentifizierung.

---

## Betrieb

```bash
# Update einspielen
git pull && docker compose up -d --build

# Logs
docker compose logs -f app
docker compose logs -f worker

# Neustart nur des Workers (z. B. nach hängendem SMTP)
docker compose restart worker

# Backup — beides zusammen aufbewahren, einzeln ist es wertlos
docker compose exec -T db pg_dump -U mailing mailing | gzip > "backup-$(date +%F).sql.gz"
grep FIELD_ENCRYPTION_KEY .env    # → an einen sicheren Ort

# Restore
gunzip -c backup-YYYY-MM-DD.sql.gz | docker compose exec -T db psql -U mailing mailing
```

Das Schema wird beim Start des `app`-Containers automatisch per
`prisma db push` abgeglichen.

---

## Wenn es nicht klappt

| Symptom | Ursache / Abhilfe |
|---|---|
| Caddy-Log: `could not get certificate` | **Häufigster Fall hier:** der Wildcard-Record greift noch, es fehlt der eigene A-Record für `mailing` (siehe Schritt 1). Sonst: Port 80 von außen zu. `sh scripts/preflight.sh mailing.rss-fb.com` |
| Seite zeigt eine all-inkl-Fehlerseite oder fremden Inhalt | DNS zeigt über die Wildcard weiter auf `85.13.166.232`. Eigenen A-Record anlegen bzw. Propagation abwarten |
| `address already in use` beim Caddy-Start | Es läuft schon ein Webserver auf 80/443 → Variante B |
| Zertifikat für IPv6-Adresse schlägt fehl | Falscher oder überzähliger `AAAA`-Record bei all-inkl |
| Login-Seite lädt, Anmeldung wirft zurück auf `/login` | `APP_URL` nicht auf `https://…` gesetzt, oder `SESSION_SECRET` kürzer als 32 Zeichen |
| Kampagne bleibt auf „Läuft“, nichts wird gesendet | Worker-Container prüfen. Zusätzlich: Sendefenster (Wochentag/Uhrzeit) und Tageslimits der Absender |
| `FIELD_ENCRYPTION_KEY … 64 Hex-Zeichen` | `openssl rand -hex 32` verwenden, nicht `-hex 64` |
| Abmeldelinks in Mails zeigen auf `localhost` | `APP_URL` korrigieren und `docker compose up -d` neu ausführen |
| Nach Key-Wechsel sind Kontakte leer | `FIELD_ENCRYPTION_KEY` wurde geändert. Alten Schlüssel zurücksetzen — ohne ihn sind die Daten verloren |

Let's Encrypt hat ein Rate Limit von 5 Fehlversuchen pro Stunde und Domain. Bei
wiederholten Fehlschlägen also erst den Preflight sauber bekommen, statt den
Container mehrfach neu zu starten.
