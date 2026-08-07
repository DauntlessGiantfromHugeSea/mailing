# Mailing — randomisierter Drip-Versand über Hostinger

Ein Tool für E-Mail-Kampagnen, die **nicht sofort** rausgehen: jede Mail bekommt
einen eigenen, zufällig gestreuten Sendezeitpunkt im Minutentakt — innerhalb
eines definierten Sendefensters und verteilt über mehrere Absender-Postfächer.
Der Ansatz entspricht dem von instantly.ai.

Design und Bedienung folgen dem
[Teilnahmemanagement](https://github.com/DauntlessGiantfromHugeSea/Teilnahmemanagement)
(Next.js 14 App Router, Tailwind, Prisma, „Liquid Glass“-Theme, brand-Teal
`rgb(0,126,128)`).

---

## Wichtig: was die Hostinger-API kann — und was nicht

**Die öffentliche Hostinger-API hat keinen Endpunkt zum Versenden von E-Mails.**
Geprüft gegen die OpenAPI-Spec (v1.30.0, Stand der Recherche):

| Bereich | Was es gibt |
|---|---|
| `/api/mail/v1/…` | Postfächer anlegen/löschen, Aliase, Weiterleitungen, Catch-Alls, Pläne & Quotas, **Zustell-Logs (inbound/outbound)**, Webhooks, API-Tokens |
| `/api/reach/v1/…` | Kontakte, Segmente, Tags, Profile, Custom Fields, **DNS-Status der Absenderdomain** |

Ein `POST …/send` oder Ähnliches existiert dort nicht. Der eigentliche Versand
läuft deshalb über **SMTP** (`smtp.hostinger.com`) mit den Zugangsdaten des
jeweiligen Postfachs.

Die API übernimmt in diesem Tool alles drumherum:

- **Postfächer einlesen** → `GET /api/mail/v1/orders`, `…/mailboxes`
  Absender müssen nicht abgetippt werden; sie werden aus dem Konto geladen.
- **Tageslimits ableiten** → `GET /api/mail/v1/orders/{id}/plan`
  Das Plan-Limit wird als Vorschlag für das Tageslimit übernommen.
- **Zustellbarkeit prüfen** → `GET /api/reach/v1/profiles/{uuid}/domains/dns-status`
  SPF/DKIM/DMARC-Preflight. Ohne saubere Authentifizierung landet auch ein
  perfekt getakteter Versand im Spam.
- **Zustellung abgleichen** → `GET /api/mail/v1/orders/{id}/logs/outbound`
  SMTP bestätigt nur die *Annahme*. Dieses Log sagt, was Hostinger daraus
  gemacht hat — `Failed`-Einträge werden zurückgeschrieben und zählen als Bounce.
- **Kontakte übernehmen** → `GET /api/reach/v1/profiles/{uuid}/contacts`

Ohne API-Token funktioniert das Tool vollständig; es entfallen nur diese
Komfort- und Kontrollfunktionen. Absender lassen sich dann manuell anlegen.

---

## Wie die Taktung funktioniert

Beim Start einer Kampagne wird **sofort der komplette Zeitplan festgeschrieben**:
für jeden Empfänger entsteht eine `SendJob`-Zeile mit eigenem `scheduledAt`.
Ein Worker holt fällige Jobs und versendet sie **einzeln, nacheinander**.

1. **Reihenfolge mischen** — Fisher-Yates, damit nicht alphabetisch bzw. in
   Importreihenfolge gesendet wird.
2. **Abstände streuen** — Basisabstand ± Jitter in Prozent.
   `3 min ±60 %` ergibt Abstände von 1,2 bis 4,8 Minuten. Die Werte liegen auf
   **Sekunden**, nicht auf ganzen Minuten — ein Takt exakt auf `:00` ist als
   Automat erkennbar. Untergrenze: 20 s.
3. **Sendefenster falten** — nur an gewählten Wochentagen und Uhrzeiten
   (zeitzonenbewusst über luxon). Läuft das Fenster ab, zählt der Takt am
   nächsten Sendetag weiter; die Nacht dazwischen zählt nicht.
4. **Absender rotieren** — die Last verteilt sich auf mehrere Postfächer.
   Es gewinnt jeweils das relativ am wenigsten ausgelastete Postfach; bei
   Gleichstand das, das am längsten nichts gesendet hat.
5. **Tageslimit & Warmup** — pro Postfach ein Limit. Bei aktivem Warmup startet
   ein neues Postfach bei `warmupStart` und steigt täglich um `warmupStep` bis
   zum `dailyLimit`. Ist das Limit erreicht, wird der Rest **auf den nächsten
   Tag verschoben** — nicht als Fehler markiert.
6. **Textvarianten** — Spintax `{Hallo|Guten Tag|Hi}` wählt pro Empfänger eine
   Variante. Die Auswahl ist deterministisch aus `Seed + Kontakt-ID`, ein
   Wiederholungsversuch erzeugt also dieselbe Mail.

Der `randomSeed` der Kampagne legt Mischung und Abstände fest: gleicher Seed →
gleicher Plan. Deshalb zeigt die Vorschau im Formular exakt das, was später
eingeplant wird, und ein Neuplanen nach einer Pause erzeugt keine völlig
anderen Abstände.

### Pausieren und Fortsetzen

Beim Fortsetzen werden Termine, die während der Pause verfallen sind, **um die
Pausendauer nach hinten verschoben**. Sonst gingen alle verpassten Mails auf
einmal raus — genau der Effekt, den das Tool verhindern soll.

---

## Schnellstart

```bash
git clone <repo> && cd mailing
npm install
cp .env.example .env
```

`.env` füllen — mindestens:

```bash
DATABASE_URL="postgresql://user:pass@localhost:5432/mailing?schema=public"
FIELD_ENCRYPTION_KEY="$(openssl rand -hex 32)"   # 64 Hex-Zeichen
SESSION_SECRET="$(openssl rand -hex 48)"
APP_URL="http://localhost:3000"                   # muss von außen erreichbar sein
SEED_ADMIN_EMAIL="admin@example.com"
SEED_ADMIN_PASSWORD="…"
```

Dann:

```bash
npm run db:push      # Schema anlegen
npm run db:seed      # ersten Admin anlegen
npm run dev          # App auf :3000
npm run worker       # in einem ZWEITEN Terminal — ohne ihn wird nichts gesendet
```

> Der Worker ist ein eigener Prozess. Ohne ihn werden Kampagnen geplant, aber
> nie versendet.

### Docker

```bash
cp .env.example .env    # POSTGRES_PASSWORD, Secrets etc. setzen
RUN_SEED_ON_START=1 docker compose up -d --build
# danach RUN_SEED_ON_START wieder auf 0 setzen
```

Compose startet drei Container: `db`, `app` und `worker`.

---

## Reihenfolge beim ersten Einrichten

1. **Einstellungen** → Hostinger-API-Token eintragen, „Verbindung testen“.
2. **Einstellungen** → „Zustellbarkeit prüfen“: SPF/DKIM/DMARC müssen stehen.
3. **Absender** → „Postfächer aus Hostinger laden“, SMTP-Passwort je Postfach
   eintragen, danach **„testen“** klicken (prüft Verbindung und Login).
4. **Kontakte** → CSV importieren oder aus Hostinger Reach übernehmen.
5. **Kampagnen** → „Neue Kampagne“. Taktung und Sendefenster einstellen, die
   Vorschau rechts zeigt die konkreten Zeitpunkte.
6. **Starten.** Das Dashboard zeigt die Warteschlange live.

---

## Aufbau

```
prisma/schema.prisma      Datenmodell
src/lib/
  hostinger.ts            API-Client (Mail + Reach)
  hostingerSync.ts        Postfach-Import, DNS-Preflight, Log-Abgleich
  mailer.ts               SMTP-Versand, ein Transport pro Postfach
  random.ts               Seeded PRNG, Shuffle, Jitter
  sendWindow.ts           Sendefenster-Arithmetik (Zeitzonen, Tageswechsel)
  schedule.ts             Zeitplan bauen + Vorschau
  senders.ts              Rotation, Tageslimit, Warmup
  campaigns.ts            Planen, Starten, Pausieren, Fortsetzen, Abbrechen
  worker.ts               tick(): fällige Jobs holen und versenden
  contacts.ts             Kontakte, CSV-Parser, Abmeldung
  templates.ts            Platzhalter + Spintax
worker/main.ts            Worker-Prozess (adaptiver Schlaf)
scripts/test-*.ts         Tests (siehe unten)
```

### Versand-Trigger: Worker oder Cron

Zwei Wege, dieselbe `tick()`-Funktion, dasselbe DB-Lock — Parallelbetrieb ist
unschädlich:

- **Worker-Prozess** (empfohlen): `npm run worker`. Schläft adaptiv — steht der
  nächste Job erst in 40 Minuten an, wird nicht sekündlich gepollt.
- **Externer Cron**: `CRON_SECRET` setzen, dann minütlich
  `curl -H "Authorization: Bearer $CRON_SECRET" https://…/api/cron/tick`.
  Ohne gesetztes `CRON_SECRET` ist der Endpunkt deaktiviert.

---

## Sicherheit und Datenschutz

- **Feldverschlüsselung** (AES-256-GCM) für Kontaktdaten, SMTP-Passwörter und
  das Hostinger-Token. Lookups laufen über HMAC-Blind-Indizes (`emailHash`),
  Klartext-E-Mails stehen nicht in der Datenbank.
  ⚠️ Wird `FIELD_ENCRYPTION_KEY` geändert, sind alle bestehenden Werte unlesbar.
- **Abmeldung**: jede Mail trägt `List-Unsubscribe` mit One-Click-Post und einen
  Link im Text (wird automatisch angehängt, falls im Template nicht vorhanden).
  Eine Abmeldung landet auf einer **globalen Sperrliste**, die ein CSV-Reimport
  nicht aushebelt, und zieht bereits eingeplante Mails zurück.
- **Bounce-Handling**: zwei Zustellfehler laut Hostinger-Log → Kontakt wird auf
  `BOUNCED` gesetzt und gesperrt.
- **Rollen**: `ADMIN` (alles inkl. Einstellungen), `EDITOR` (Kampagnen,
  Kontakte, Absender), `VIEWER` (nur lesen).

Der Betrieb eines Kaltakquise-Versands unterliegt in der EU/DE engen Regeln
(DSGVO, UWG §7). Das Tool erzwingt Abmeldelink und Sperrliste, ersetzt aber
keine Rechtsgrundlage für den Versand.

---

## Tests

Die Tests laufen gegen echte Infrastruktur — eine echte Postgres-Instanz und
einen echten SMTP-Server (Test-Sink), keine Mocks.

```bash
# 1) Taktungs-Logik (reine Funktionen, keine DB nötig)
npx tsx scripts/test-schedule.ts

# 2) Versandpfad gegen DB + SMTP-Sink
node scripts/smtp-sink.js 2525 /tmp/sink.jsonl &        # Test-SMTP-Server
SINK_LOG=/tmp/sink.jsonl npx tsx --env-file-if-exists=.env scripts/test-send.ts

# 3) Echtzeit-Takt (dauert ~4 Minuten)
SINK_LOG=/tmp/sink.jsonl npx tsx --env-file-if-exists=.env scripts/test-realtime.ts setup
npm run worker            # laufen lassen
SINK_LOG=/tmp/sink.jsonl npx tsx --env-file-if-exists=.env scripts/test-realtime.ts verify
```

Abgedeckt: Jitter-Grenzen und -Verteilung (σ gegen Theorie), Sendefenster
inkl. Tages- und Wochenendwechsel, Seed-Reproduzierbarkeit, echter
SMTP-Versand, Absender-Rotation, Tageslimit, Warmup-Rampe, Abmeldung zieht
Jobs zurück, Platzhalter- und Spintax-Rendering, `List-Unsubscribe`-Header,
und im Echtzeit-Test der tatsächlich gemessene Abstand zwischen den Mails.
