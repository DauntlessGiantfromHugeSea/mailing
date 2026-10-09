# Offene Hinweise (Needs Validation) – Mailing-Tool (mailing)

Diese Punkte sind **keine bestätigten Schwachstellen** und haben deshalb keine Schwere. Ihnen fehlt ein Fakt, der nur am Betrieb oder mit einer Fixture geklärt werden kann.

## Microsoft-Login ordnet Konten über den veränderlichen E-Mail-Claim zu und überschreibt eine bestehende Entra-Objekt-ID-Bindung

- Fingerprint: `mailing:auth/microsoft/callback:email-claim-account-linking-overrides-oid-binding`
- Stand: gehärtet – E-Mail-Zuordnung nur ohne oder mit gleicher oid

**Beschreibung.** Der OIDC-Callback sucht den Benutzer zuerst über die Entra-Objekt-ID (msOid) und, wenn diese nicht gefunden wird, über die E-Mail aus dem ID-Token (`email`, ersatzweise `preferred_username`). Ein Konto, das bereits an eine ANDERE oid gebunden ist, wird trotzdem per E-Mail ausgewählt; danach wird msOid mit der neuen oid überschrieben und eine Session mit der gespeicherten Rolle (z. B. ADMIN) ausgestellt. Jede Entra-Identität, deren Token die E-Mail eines App-Benutzers, aber eine andere oid trägt, meldet sich damit als dieser Benutzer an und übernimmt die Bindung; der rechtmäßige Inhaber verliert dabei die oid-Zuordnung (nach einer Adressänderung ist er ausgesperrt). Das widerspricht DEPLOY.md:389-390. Unabhängig lokal nachvollzogen mit dem echten Route-Handler (gemockt nur Prisma, Cookies, Session, Audit sowie Token-Tausch/-Prüfung; Dummy-Daten): Benutzer u-admin {email admin@fb-eng.example, role ADMIN, msOid oid-A}; Identität {oid oid-B, email admin@fb-eng.example} -> 303 /dashboard, Session uid=u-admin role=ADMIN, msOid oid-A -> oid-B; anschließend Inhaber oid-A mit geänderter E-Mail -> abgewiesen (Aussperrung). Mit gepatchter Kopie (E-Mail-Fallback nur, wenn msOid des Treffers null ist) wird derselbe Versuch abgewiesen, msOid bleibt oid-A, Erstverknüpfung unverbundener Altkonten und oid-Zuordnung nach Adressänderung funktionieren weiter. Offen ist allein, ob ein niedriger berechtigter Akteur ein solches Token erhalten kann (IdP-Seite). Behebung: in callback/route.ts den E-Mail-Fallback nur zulassen, wenn der gefundene Benutzer noch keine msOid hat (oder dieselbe), sonst abweisen und auditieren; msOid in update nur setzen, wenn bisher null. Ergänzend: bei common/organizations/consumers-Tenant den Start verweigern bzw. tid stets gegen eine konfigurierte Tenant-GUID prüfen.

**Vermutete Ursache.** src/app/api/auth/microsoft/callback/route.ts:80-82 nutzt den E-Mail-Claim als Fallback-Selektor, ohne zu verlangen, dass der per E-Mail gefundene Benutzer unverbunden (msOid null) oder an dieselbe oid gebunden ist; route.ts:121-129 schreibt die vorgelegte oid bedingungslos in msOid. Der E-Mail-Wert stammt aus den veränderlichen, nicht zwingend verifizierten Claims `email`/`preferred_username` (src/lib/authMicrosoft.ts:283). Die tid-Bindung wird nur bei GUID-Wert von MICROSOFT_TENANT_ID erzwungen (authMicrosoft.ts:272-277); praktisch relevant ist das nur für common/organizations, da bei einem Domainnamen die Autorität (authMicrosoft.ts:133-134) ohnehin nur Tokens dieses Tenants ausstellt.

**Trace**

1. `src/app/api/auth/microsoft/callback/route.ts:26` (entrypoint) – Anonymer OIDC-Callback; code/state stammen aus einem Ablauf, den der Akteur in seinem eigenen Browser gestartet hat (State/Nonce/PKCE-Cookies binden nur an diesen Browser, nicht an ein Zielkonto).
2. `src/lib/authMicrosoft.ts:275` (propagation) – tid wird nur bei GUID-Konfiguration gegen MICROSOFT_TENANT_ID geprüft; der Issuer (264) wird aus dem tid des Tokens selbst gebildet.
3. `src/lib/authMicrosoft.ts:283` (propagation) – email = payload.email ?? payload.preferred_username, kleingeschrieben; kein Verifizierungsstatus (z. B. xms_edov) wird ausgewertet.
4. `src/app/api/auth/microsoft/callback/route.ts:68` (propagation) – domainAllowed prüft nur die Domain desselben E-Mail-Claims.
5. `src/app/api/auth/microsoft/callback/route.ts:82` (propagation) – Findet findFirst({msOid}) nichts, wählt findUnique({email}) das Opferkonto, obwohl es an eine andere oid gebunden ist.
6. `src/app/api/auth/microsoft/callback/route.ts:124` (propagation) – msOid des Opferkontos wird mit der oid des Akteurs überschrieben.
7. `src/app/api/auth/microsoft/callback/route.ts:131` (sink) – createSession stellt eine Session mit uid und Rolle des Opferkontos aus.

**Belege**

- `src/app/api/auth/microsoft/callback/route.ts:80` – Zuordnung über msOid mit bedingungslosem E-Mail-Fallback (Zeilen 80-82).
- `src/app/api/auth/microsoft/callback/route.ts:121` – prisma.user.update setzt msOid: identity.oid ohne Vergleich mit der bestehenden Bindung (121-129).
- `src/lib/authMicrosoft.ts:283` – Kontoselektor aus den veränderlichen Claims email/preferred_username.
- `prisma/schema.prisma:44` – msOid ist als stabile, eindeutige Kennung dokumentiert (Kommentar 42-43), wird aber nach dem Setzen nicht als Bindung durchgesetzt.
- `DEPLOY.md:389` – Dokumentation: ab der zweiten Anmeldung läuft die Zuordnung über die oid; der Quelltext setzt das nicht durch.
- `src/lib/authMicrosoft.ts:101` – configProblem lässt common/organizations zu, sobald MICROSOFT_ALLOWED_DOMAINS gesetzt ist; dann ist der E-Mail-Claim die einzige mandantenunabhängige Schranke.
- `agents/v3-ml-01/artifacts/verify-link-out.txt:1` – Unabhängige lokale Prüfung (Sandbox, Dummy-Daten): Originalroute T2 -> Session u-admin/ADMIN, msOid oid-A -> oid-B, T4 Inhaber ausgesperrt; gepatchte Kopie T2 -> abgewiesen, msOid unverändert, T3/T4 funktionieren.

**Blocker**

- Nicht quelltextsichtbar: ob im produktiven Entra-Tenant ein anderer Akteur als der Kontoinhaber für diesen Client ein ID-Token erhalten kann, dessen email (oder preferred_username) einer bestehenden App-Benutzeradresse entspricht, dessen oid aber abweicht (Wiederverwendung einer Adresse nach Austritt, durch User-/Exchange-Administrator gesetztes mail-Attribut, B2B-Gast mit passendem email-Claim, unverifizierte Domain).
- Nicht quelltextsichtbar: der produktive Wert von MICROSOFT_TENANT_ID (GUID, Domainname oder common/organizations) und die Kontotypen der App-Registrierung; nur bei common/organizations zusammen mit einer mandantenübergreifenden Registrierung werden Tokens fremder Tenants akzeptiert.
- Entra-Verhalten zu removeUnverifiedEmailClaim/xms_edov für diese App-Registrierung ist IdP-Konfiguration und lokal nicht beobachtbar.

**Klärung**

- *local*: Harness in agents/v3-ml-01/artifacts/verify-link-out.txt (echte callback/route.ts, gemockt nur Prisma/Cookies/Session/Audit und exchangeCode/verifyIdToken) nach dem Fix gegen die echte Route erneut ausführen. Erwartet: T2 (oid-B, E-Mail des an oid-A gebundenen Kontos) -> Weiterleitung /login mit Fehler, keine Session, msOid bleibt oid-A, Audit auth.microsoftRejected; T3 (unverbundenes Altkonto) und T4 (Inhaber oid-A mit geänderter E-Mail) -> /dashboard. Regressionstest: Benutzer {email:E, msOid:A} anlegen; Callback mit verifizierter Identität {oid:B, email:E} darf keine Session erzeugen und msOid nicht ändern; Benutzer {email:F, msOid:null} mit {oid:C, email:F} wird verknüpft. Fix: in route.ts:80-82 bei Treffer nur per E-Mail abweisen, wenn byEmail.msOid gesetzt und != identity.oid; in 121-129 msOid nur schreiben, wenn bisher null.
- *deployment*: Vom Betreiber in Entra zu prüfen, ohne App-Verkehr: MICROSOFT_TENANT_ID in deploy/.env ist die Tenant-GUID und die App-Registrierung ist Single-Tenant; ob ein anderes Benutzer-/Gastobjekt als die App-Benutzer deren Adresse in mail/otherMails/UPN trägt oder früher getragen hat (Adresswiederverwendung); welche Entra-Rollen unterhalb Global Admin (User Administrator, Exchange Administrator) das mail-Attribut setzen dürfen; im App-Manifest authenticationBehaviors.removeUnverifiedEmailClaim. Jeder solche Pfad bestätigt die Übernahme.

## EDITOR-Aktion „freigeben“ löscht empfängerseitige Abmeldung/Beschwerde aus der Sperrliste und gibt die Adresse wieder für den Versand frei

- Fingerprint: `mailing:contacts-actions:reactivate-deletes-recipient-optout-suppression`
- Stand: gehärtet – Abmeldung/Beschwerde darf nur ein ADMIN aufheben (protokolliert)

**Beschreibung.** POST /api/contacts/{id}/actions mit action=reactivate (UI-Button „freigeben“ für jeden nicht-ACTIVE Kontakt) setzt status=ACTIVE, unsubscribedAt=null, bounceCount=0 und löscht per suppression.deleteMany den globalen Sperreintrag unabhängig vom Grund (unsubscribe, complaint, bounce, manual, Verteiler-Sperre). Weder Rolle (EDITOR genügt) noch Kontaktstatus noch Sperrgrund werden geprüft. Danach nimmt resolveRecipients den Kontakt wieder in neue Kampagnen auf, und die Sendezeitprüfung im Worker (status ACTIVE, kein Sperreintrag) lässt den Versand durch. Dem Empfänger wurde bei der Abmeldung „Sie erhalten keine weiteren Nachrichten“ zugesagt; README verspricht eine globale Sperrliste, die ein Reimport nicht aushebelt. Der Audit-Eintrag contact.reactivate speichert weder vorherigen Status noch Sperrgrund, unsubscribedAt wird genullt – der Nachweis der Abmeldung geht damit verloren. Gegenläufige Quellenlage: Die Fehlermeldung beim manuellen Anlegen (src/app/api/contacts/route.ts:62) fordert ausdrücklich dazu auf, gesperrte Adressen („Abmeldung oder Zustellfehler“) über „Alle“ zu suchen und freizugeben, „falls das gewollt ist“ – das Aufheben durch Editoren ist also bewusst vorgesehen. Teilweise Gegenkontrolle nur bei aktiver Verteiler-Integration: Ist die Abmeldung über den check-Rückkanal an den Verteiler gemeldet worden und schickt dieser sie als Sperre zurück, legt runSync den Sperreintrag beim nächsten Abgleich neu an und sperrt den Kontakt (src/lib/verteilerSync.ts:139-181); bis dahin geplante/gesendete Mails sind davon nicht erfasst.

**Vermutete Ursache.** Die Reaktivierung unterscheidet nicht zwischen intern verhängten Sperren (manual, bounce) und empfängerseitigen Widersprüchen (unsubscribe, complaint), löscht den einzigen Datensatz des Widerspruchs hart (statt Tombstone) und protokolliert weder vorherigen Status, Sperrgrund noch einen Nachweis einer erneuten Einwilligung.

**Trace**

1. `src/app/api/contacts/[id]/actions/route.ts:52` (entrypoint) – Nur getSession + canEdit (ADMIN oder EDITOR, Zeile 13); keine Prüfung von contact.status oder suppression.reason.
2. `src/app/api/contacts/[id]/actions/route.ts:55` (propagation) – status=ACTIVE, unsubscribedAt=null (Abmeldezeitpunkt gelöscht), bounceCount=0.
3. `src/app/api/contacts/[id]/actions/route.ts:57` (propagation) – suppression.deleteMany({ emailHash }) entfernt den globalen Sperreintrag jeden Grundes ohne Tombstone.
4. `src/lib/campaigns.ts:35` (propagation) – Abzug der Sperrliste greift nicht mehr; ACTIVE-Kontakt wird bei planCampaign wieder Empfänger.
5. `src/lib/worker.ts:164` (sink) – Sendezeitprüfung (status !== ACTIVE || Sperreintrag) passiert; anschließend Versand über sendViaSender (worker.ts:215).

**Belege**

- `src/app/abmelden/page.tsx:47` – Zusage an den Empfänger: „Sie erhalten keine weiteren Nachrichten.“
- `src/lib/contacts.ts:288` – unsubscribeByToken legt Suppression{reason:'unsubscribe'} an – einziger dauerhafter Nachweis neben contact.unsubscribedAt.
- `src/app/contacts/page.tsx:308` – „freigeben“ wird für jeden Status ungleich ACTIVE angeboten, also auch UNSUBSCRIBED/COMPLAINED.
- `src/app/api/contacts/[id]/actions/route.ts:75` – Designabsicht beim Löschen: Sperrliste bleibt bestehen, damit ein Reimport keine abgemeldete Adresse wieder anschreibt.
- `README.md:191` – Abmeldung landet auf einer globalen Sperrliste, die ein CSV-Reimport nicht aushebelt (Zeilen 191-192).
- `src/app/api/contacts/[id]/actions/route.ts:58` – Audit-Eintrag contact.reactivate ohne detail: kein vorheriger Status, kein Sperrgrund, kein Einwilligungsnachweis.
- `src/app/api/contacts/route.ts:62` – Gegenbeleg: UI-Text empfiehlt ausdrücklich, gesperrte Adressen („Abmeldung oder Zustellfehler“) bei Bedarf freizugeben – Aufheben durch Editoren ist bewusst vorgesehen.
- `src/lib/verteilerSync.ts:150` – Teilweise Gegenkontrolle: Verteiler-Sperren werden beim Abgleich neu angelegt und Kontakte erneut gesperrt – nur wenn die Integration aktiv ist und der Verteiler die Abmeldung führt.

**Blocker**

- Die maßgebliche Regel ist nicht im Quelltext sichtbar: Ob EDITORs empfängerseitige Widersprüche (UNSUBSCRIBED, COMPLAINED) überhaupt aufheben dürfen und welcher Nachweis einer erneuten Einwilligung dabei festzuhalten ist, ist eine Betreiber-/Rechtsentscheidung. Der Quelltext ist widersprüchlich (Zusage „keine weiteren Nachrichten“ und README einerseits, ausdrückliche Freigabe-Empfehlung in src/app/api/contacts/route.ts:62 andererseits), daher lässt sich die Absicht nicht lokal entscheiden. Der technische Ablauf selbst ist vollständig im Quelltext belegt; ein lokaler Lauf würde die offene Frage nicht klären.

**Klärung**

- *local*: Optional, nicht entscheidend: Den In-Memory-Prisma-Stub aus agents/ml-h6/artifacts/combined.cjs um ein Modell auditLog erweitern und @/lib/session (getSession -> role EDITOR) sowie die Antwort-Helfer aus @/lib/http stubben; einen Dummy-Kontakt (dummy@example.invalid) mit status UNSUBSCRIBED und Suppression{reason:'unsubscribe'} anlegen, den reactivate-Zweig von POST src/app/api/contacts/[id]/actions/route.ts mit Formularfeld action=reactivate aufrufen, dann planCampaign + launchCampaign + einen tick mit gestubbtem Mailer ausführen; erwartet: ein aufgezeichneter Versand an den Dummy-Kontakt, kein Suppression-Datensatz mehr, unsubscribedAt=null, AuditLog contact.reactivate ohne detail.
- *deployment*: Betreiber legt die Regel fest (z. B. „Abmeldungen/Beschwerden dürfen nie bzw. nur von ADMIN mit dokumentierter neuer Einwilligung aufgehoben werden“). Besteht eine solche Regel, gilt der Befund als bestätigt. Fix: reactivate ablehnen, wenn suppression.reason in (unsubscribe, complaint) oder contact.status in (UNSUBSCRIBED, COMPLAINED) – ggf. nur für ADMIN mit Pflichtfeld Einwilligungsnachweis; Sperreintrag nicht löschen, sondern als aufgehoben markieren (liftedAt/liftedBy/Begründung); im Audit vorherigen Status, Sperrgrund, unsubscribedAt und Begründung im detail speichern; Hinweistext in src/app/api/contacts/route.ts:62 entsprechend anpassen. Zusätzlich prüfen, ob in der Produktion bereits contact.reactivate-Einträge für vormals abgemeldete Kontakte existieren (AuditLog lesen, nicht verändern).

## Seed-Pfad fällt bei leerem SEED_ADMIN_PASSWORD auf das im Repository veröffentlichte ADMIN-Passwort „ChangeMe!2026“ zurück, Warnung wird verworfen

- Fingerprint: `mailing:docker-compose.yml:SEED_ADMIN_PASSWORD-default-ChangeMe`
- Stand: gehärtet – kein Standardpasswort mehr; Seed nur mit ≥ 12 Zeichen

**Beschreibung.** docker-compose.yml:53 setzt SEED_ADMIN_PASSWORD: ${SEED_ADMIN_PASSWORD:-ChangeMe!2026}. Der Operator ':-' ersetzt auch einen leeren Wert; .env.example:94 liefert SEED_ADMIN_PASSWORD="" aus. Lokal (Sandbox, docker compose v5.3.1 config, .env aus .env.example mit Dummy-Secrets, RUN_SEED_ON_START=1 wie DEPLOY.md:196/219) wird für app und worker SEED_ADMIN_PASSWORD: ChangeMe!2026 und SEED_ADMIN_EMAIL: admin@example.com gerendert; die übrigen Pflicht-Secrets (docker-compose.yml:33-36) scheitern dagegen mit ${VAR:?} geschlossen. Mit RUN_SEED_ON_START=1 führt docker-entrypoint.sh:13 'npx tsx prisma/seed.ts 2>/dev/null' aus; die einzige Warnung (seed.ts:23-24, console.warn auf stderr) wird verworfen, der Fallback node -e (Zeile 19) setzt ebenfalls 'ChangeMe!2026' ohne Warnung. Beide Varianten upserten den Benutzer mit role ADMIN, active true und überschreiben passwordHash bei jedem Start, solange RUN_SEED_ON_START=1 bleibt (reaktiviert auch ein deaktiviertes Admin-Konto). Die Passwortanmeldung ist standardmäßig an (authMicrosoft.ts:122) und /api/auth ist öffentlich (middleware.ts:19), ohne Rate-Limit. Ein anonymer Internet-Client kann sich dann mit den Repository-Zugangsdaten als ADMIN anmelden (Einstellungen, Hostinger-Token, Absender/SMTP, alle Kontaktdaten). Einschränkend: DEPLOY.md:151-152 und README.md:102-103 fordern ausdrücklich, SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD zu setzen, und scripts/install.sh:133,159 erzeugt ein Zufallspasswort; der Fehler greift also nur, wenn der Operator den Wert leer lässt (Fail-open statt Fail-closed). Lässt er nur das Passwort leer, aber setzt eine eigene E-Mail, muss ein Angreifer zusätzlich die Admin-Adresse kennen.

**Vermutete Ursache.** Zugangsdaten-Default statt Fail-closed: docker-compose.yml:53 (${SEED_ADMIN_PASSWORD:-ChangeMe!2026}), docker-entrypoint.sh:19 (|| 'ChangeMe!2026') und prisma/seed.ts:11 (?? 'ChangeMe!2026') liefern ein öffentlich bekanntes ADMIN-Passwort, wenn SEED_ADMIN_PASSWORD fehlt bzw. leer ist; die Warnung in seed.ts:23-24 wird durch '2>/dev/null' in docker-entrypoint.sh:13 unterdrückt, und scripts/preflight.sh:217-220 prüft SEED_ADMIN_PASSWORD nicht.

**Trace**

1. `src/app/api/auth/login/route.ts:15` (entrypoint) – Liest email/password aus dem Formular eines nicht authentifizierten Clients; Passwortanmeldung aktiv, solange AUTH_LOCAL_ENABLED nicht exakt 'false' ist (Zeile 11, authMicrosoft.ts:122).
2. `.env.example:94` (propagation) – SEED_ADMIN_PASSWORD="" und SEED_ADMIN_EMAIL="admin@example.com" (Zeile 93) werden leer bzw. mit Platzhalter ausgeliefert.
3. `docker-compose.yml:53` (propagation) – ${SEED_ADMIN_PASSWORD:-ChangeMe!2026} macht aus leer den öffentlichen Default; lokal gerendert (compose_seed_verify.txt, Abschnitt A).
4. `docker-entrypoint.sh:13` (propagation) – npx tsx prisma/seed.ts 2>/dev/null verwirft die stderr-Warnung; bei Fehlschlag (tsx ist devDependency, Dockerfile:39 --omit=dev) greift node -e mit erneutem Default 'ChangeMe!2026' (Zeile 19) ohne Warnung.
5. `prisma/seed.ts:16` (propagation) – upsert legt den Benutzer mit role ADMIN, active true und bcrypt-Hash des Default-Passworts an bzw. überschreibt passwordHash/active bei jedem Start (Zeilen 16-20; entrypoint 20-24 identisch).
6. `src/app/api/auth/login/route.ts:32` (sink) – Nach bcrypt.compare('ChangeMe!2026', hash) === true (Zeile 27) und active-Prüfung (Zeile 30) wird createSession mit role ADMIN ausgestellt.

**Belege**

- `docker-compose.yml:33` – Andere Secrets (FIELD_ENCRYPTION_KEY, SESSION_SECRET, APP_URL, Zeilen 33-36) nutzen ${VAR:?…} und brechen ab; das Seed-Passwort nicht. Lokal: Fix-Variante mit ${SEED_ADMIN_PASSWORD:?…} bricht mit 'required variable SEED_ADMIN_PASSWORD is missing a value' ab (compose_seed_verify.txt, Abschnitt B).
- `prisma/seed.ts:23` – Einzige Warnung bei Default-Passwort ist console.warn (stderr) und wird durch 2>/dev/null in docker-entrypoint.sh:13 verworfen.
- `docker-entrypoint.sh:19` – Fallback-Seed: process.env.SEED_ADMIN_PASSWORD || 'ChangeMe!2026', keine Warnung; lokal bestätigt, dass der entstehende bcrypt-Hash 'ChangeMe!2026' akzeptiert (compose_seed_verify.txt, Abschnitt D).
- `scripts/preflight.sh:217` – need-Liste (Zeilen 217-220) prüft POSTGRES_PASSWORD, FIELD_ENCRYPTION_KEY, SESSION_SECRET, APP_URL, aber nicht SEED_ADMIN_PASSWORD.
- `src/lib/authMicrosoft.ts:122` – Passwortanmeldung aktiv, außer AUTH_LOCAL_ENABLED === 'false'; .env.example:66 liefert AUTH_LOCAL_ENABLED="".
- `DEPLOY.md:152` – Mildernd: Anleitung verlangt SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD in .env; scripts/install.sh:133,159 erzeugt ein Zufallspasswort. Die Lücke greift nur bei leer gelassenem Wert.
- `DEPLOY.md:208` – RUN_SEED_ON_START muss manuell wieder auf 0; bleibt es 1, wird das Admin-Passwort bei jedem Neustart (auch über docker compose up in projektabrechung/deploy/einrichten.sh:113) zurückgesetzt und das Konto reaktiviert.

**Blocker**

- Ob die produktive .env auf dem Server (mailing.rss-fb.com) ein nicht-leeres SEED_ADMIN_PASSWORD enthält und ob je mit leerem Wert und RUN_SEED_ON_START=1 gestartet wurde, ist aus dem Repository nicht beobachtbar (install.sh erzeugt ein Zufallspasswort, der manuelle DEPLOY.md-Pfad hängt vom Operator ab).
- Ob in Produktion AUTH_LOCAL_ENABLED=false gesetzt ist (dann blockiert route.ts:11 den Passwort-Login) und ob noch ein ADMIN mit dem Default-Hash in der Datenbank existiert, ist nicht beobachtbar.

**Klärung**

- *local*: Erledigt (Sandbox, kein Netz, Dummy-Werte): docker compose config auf Kopie von docker-compose.yml mit .env aus .env.example (nur POSTGRES_PASSWORD/FIELD_ENCRYPTION_KEY/SESSION_SECRET/APP_URL als Dummies) und RUN_SEED_ON_START=1 rendert für app und worker SEED_ADMIN_PASSWORD: ChangeMe!2026, SEED_ADMIN_EMAIL: admin@example.com, AUTH_LOCAL_ENABLED: "" (A); Fix-Variante ${SEED_ADMIN_PASSWORD:?…} bricht ab (B) bzw. übernimmt einen gesetzten Wert (C); bcryptjs-Hash aus der Fallback-Logik akzeptiert 'ChangeMe!2026' (D). Artefakt: agents/v3-ml-07/artifacts/compose_seed_verify.txt. Fix: in docker-compose.yml SEED_ADMIN_PASSWORD: ${SEED_ADMIN_PASSWORD:-} (kein Default; ':?' nur, wenn das Passwort dauerhaft in .env bleiben soll); in docker-entrypoint.sh im Zweig RUN_SEED_ON_START=1 vor dem Seed abbrechen, wenn SEED_ADMIN_PASSWORD leer, kürzer als 12 Zeichen oder 'ChangeMe!2026' ist ('[ ${#SEED_ADMIN_PASSWORD} -ge 12 ] && [ "$SEED_ADMIN_PASSWORD" != "ChangeMe!2026" ] || { echo "[entrypoint] SEED_ADMIN_PASSWORD fehlt/unsicher" >&2; exit 1; }'), '2>/dev/null' entfernen und den node -e-Fallback ohne Default (bzw. ganz ohne Fallback; tsx in dependencies oder vorkompiliertes dist/seed.js) ausführen; in prisma/seed.ts den Default entfernen und bei leerem/Default-Passwort mit process.exit(1) abbrechen; scripts/preflight.sh: need SEED_ADMIN_PASSWORD ergänzen, wenn RUN_SEED_ON_START=1. Regressionstest: (1) docker compose config mit .env.example darf nie 'ChangeMe!2026' ausgeben (grep -c 'ChangeMe' == 0); (2) Shell-Test des Entrypoints mit RUN_SEED_ON_START=1 und SEED_ADMIN_PASSWORD="" bzw. 'ChangeMe!2026' muss mit Exit≠0 vor jedem DB-Zugriff enden (npx durch Stub ersetzen); (3) Unit-Test für seed.ts-Validierung mit leerem Passwort → Abbruch.
- *deployment*: Owner auf dem Server, nicht-destruktiv: (1) im Mailing-Ordner (docker inspect mailing-app, Label com.docker.compose.project.working_dir) prüfen: grep -c '^SEED_ADMIN_PASSWORD="..*"' .env (muss 1 sein) und grep '^RUN_SEED_ON_START' .env (muss fehlen oder 0 sein); docker exec mailing-app printenv AUTH_LOCAL_ENABLED RUN_SEED_ON_START. (2) In der DB alle aktiven ADMIN-Konten auflisten (SELECT email, "passwordHash" FROM "User" WHERE role='ADMIN' AND active) und offline im Container mit node -e "require('bcryptjs').compareSync('ChangeMe!2026', '<hash>')" je Hash prüfen, ohne Login am öffentlichen Endpunkt. (3) Existiert admin@example.com oder trifft ein Hash zu: Passwort sofort ändern, Konto deaktivieren und Audit-Log (action 'login') auf fremde Anmeldungen prüfen.

## SameSite=Lax ist die einzige CSRF-/Clickjacking-Kontrolle; jede same-site Origin unter rss-fb.com kann Editor-/Admin-Aktionen auslösen (z. B. Abmeldesperren aufheben)

- Fingerprint: `mailing:src/lib/session.ts:samesite-lax-sole-csrf-control-same-site-siblings`
- Stand: gehärtet – Origin/Sec-Fetch-Site-Prüfung in der Middleware, X-Frame-Options/CSP

**Beschreibung.** Alle cookie-authentifizierten Mutationen (Kontakte, Kampagnen, Absender, Einstellungen, Logout, Passwort) sind reine POST-Route-Handler, die req.formData() lesen (einfache Formular-Requests) und weder CSRF-Token noch Origin-/Referer-/Sec-Fetch-Site-Prüfung haben; Server Actions (mit Next-eigenem Origin-Check) werden nicht verwendet. Einziger Schutz ist das Attribut SameSite=Lax des Cookies ml_session (host-only, kein __Host--Präfix). SameSite bezieht sich auf die registrierbare Domain: rss-fb.com, alle über den Wildcard-Record *.rss-fb.com auf den all-inkl-Webspace zeigenden Namen (DEPLOY.md:27-33) und laut Betreibernotiz intern.rss-fb.com (Intranet/Streamlit-Verteiler) sind same-site zu mailing.rss-fb.com. Skript oder angreiferbeeinflusstes HTML auf einer dieser Origins (XSS, kompromittiertes CMS, Inhalte auf dem Webspace) kann Formulare an mailing.rss-fb.com automatisch absenden; der Browser hängt das Lax-Cookie an, und die Route läuft mit der Rolle des Opfers. Beispiele: contacts/[id]/actions action=reactivate löscht den Sperreintrag und setzt einen abgemeldeten Kontakt auf ACTIVE (gesetzliche Abmeldepflicht), settings/hostinger ersetzt das Hostinger-API-Token (ADMIN-Opfer), senders POST legt einen Absender mit beliebigem SMTP-Host an, campaigns/[id]/actions startet Versand. Der Produktions-Proxyblock (scripts/install.sh:255-258, DEPLOY.md:227-230) und next.config.mjs setzen kein X-Frame-Options/frame-ancestors, daher ist auch same-site Framing (Clickjacking) möglich; das Repo-Caddyfile des optionalen Compose-Profils setzt dagegen X-Frame-Options SAMEORIGIN. Variante: ohne __Host--Präfix kann eine Schwester-Origin ein Domain=rss-fb.com-Cookie ml_session setzen (Login-CSRF in ein Angreiferkonto, falls der Angreifer ein Konto hat). Ordinäres cross-site CSRF ist in aktuellen Browsern durch das explizite SameSite=Lax blockiert. Ob eine same-site Origin angreiferbeeinflusst ist, ist eine Deployment-Tatsache außerhalb des Repos.

**Vermutete Ursache.** src/lib/session.ts:28-34 verlässt sich für die Bindung der Anfrage an die eigene Origin ausschließlich auf das Browser-Attribut SameSite=Lax; weder src/middleware.ts noch eine Route oder src/lib/http.ts prüft Origin/Sec-Fetch-Site oder ein CSRF-Token, sodass Anfragen von same-site Schwester-Origins als First-Party behandelt werden.

**Trace**

1. `src/app/api/contacts/[id]/actions/route.ts:7` (entrypoint) – Formular-POST von einer same-site Schwester-Origin (Origin https://<x>.rss-fb.com) erreicht den Route-Handler; der Browser sendet ml_session mit, weil SameSite=Lax same-site Requests zulässt.
2. `src/middleware.ts:28` (propagation) – Prüft nur die Anwesenheit des Cookies ml_session; keine Origin-/Sec-Fetch-Site-/CSRF-Prüfung; danach NextResponse.next() (Zeile 32).
3. `src/lib/session.ts:30` (propagation) – Cookie mit sameSite 'lax', host-only, ohne __Host--Präfix gesetzt; getSession (Zeile 37-46) prüft nur JWT-Signatur/Ablauf, nicht die Herkunft der Anfrage.
4. `src/app/api/contacts/[id]/actions/route.ts:13` (propagation) – canEdit(session) ist für ein EDITOR-/ADMIN-Opfer erfüllt; die Aktion stammt aus dem vom Angreifer gelieferten Formular (Zeile 18-19).
5. `src/app/api/contacts/[id]/actions/route.ts:57` (sink) – prisma.suppression.deleteMany entfernt den Sperreintrag; der Kontakt wird zuvor auf ACTIVE mit unsubscribedAt null gesetzt (Zeile 53-56).

**Belege**

- `src/lib/session.ts:30` – sameSite: 'lax' ist die einzige herkunftsbezogene Kontrolle am Session-Cookie; kein Domain-Attribut, kein __Host--Präfix (Zeile 28-34).
- `src/middleware.ts:28` – Middleware-Gate prüft nur die Cookie-Anwesenheit; grep über src/ und next.config.mjs findet keine Behandlung von Origin, Referer, Sec-Fetch-* oder CSRF-Token und keine Server Actions ('use server').
- `src/app/api/contacts/[id]/actions/route.ts:57` – reactivate löscht den Sperreintrag; der lokale Harness von ml-h5 (agents/ml-h5/artifacts/csrf-samesite-check.txt) beobachtete contact.update + suppression.deleteMany bei einem POST mit Origin https://other.rss-fb.com und Sec-Fetch-Site same-site; ohne Cookie 303 /login und 0 DB-Aufrufe.
- `src/app/api/settings/hostinger/route.ts:26` – ADMIN-only Ersetzen des Hostinger-Tokens über dieselbe Request-Form erreichbar (nur isAdmin, Zeile 11; Formulardaten Zeile 13-24).
- `DEPLOY.md:32` – Dokumentiert einen Wildcard-Record *.rss-fb.com auf den all-inkl-Webspace (85.13.166.232); rss-fb.com und beliebige Subdomains sind same-site zu mailing.rss-fb.com.
- `scripts/install.sh:257` – Produktions-Caddyblock (Variante hinter vorhandenem Proxy) besteht nur aus encode + reverse_proxy: kein X-Frame-Options/CSP frame-ancestors; next.config.mjs setzt keine headers().
- `Caddyfile:26` – Kalibrierung: das optionale Compose-Caddy-Profil setzt X-Frame-Options SAMEORIGIN, wird laut Projektnotiz in Produktion aber nicht verwendet (System-Caddy).

**Blocker**

- Ob eine Origin unter rss-fb.com (Website rss-fb.com, Wildcard *.rss-fb.com auf dem all-inkl-Webspace, intern.rss-fb.com mit Intranet/Verteiler, weitere Subdomains) angreiferbeeinflusstes HTML/JS ausliefert oder eine XSS hat, ist eine Deployment-Tatsache außerhalb dieses Repos; ohne eine solche Schwester-Origin kann ein Angreifer die Anfrage in aktuellen Browsern nicht erzeugen.
- Der produktive System-Caddy (/etc/caddy/Caddyfile) ist nicht einsehbar; er könnte für mailing.rss-fb.com X-Frame-Options/CSP frame-ancestors ergänzen.
- Die Browser-Durchsetzung von SameSite=Lax für same-site Formular-POSTs wurde nicht in einem echten Browser ausgeführt (kein Browser in der Sandbox); die Serverseite akzeptiert die Anfrage nachweislich.

**Klärung**

- *local*: Nach dem Fix den Harness aus agents/ml-h5/artifacts/csrf-samesite-check.txt erneut ausführen: POST mit Origin https://other.rss-fb.com bzw. Sec-Fetch-Site same-site und gültigem EDITOR-Cookie muss 403 mit null Prisma-Aufrufen liefern, Origin https://mailing.rss-fb.com bzw. Sec-Fetch-Site same-origin weiterhin Erfolg. Optional im lokalen Browser mit /etc/hosts-Einträgen a.test.local und mailing.test.local (gleiche registrierbare Domain) ein Auto-Submit-Formular von a.test.local an den Dev-Server senden und prüfen, dass das Cookie vor dem Fix mitgesendet und die Anfrage nach dem Fix abgelehnt wird.
- *deployment*: Betreiber inventarisiert alle Hosts unter rss-fb.com (DNS-Zone inkl. Wildcard-Ziel, CMS von rss-fb.com, Apps auf intern.rss-fb.com) und bestätigt, dass keiner nutzerkontrolliertes HTML/JS ausliefert; Betreiber führt `curl -sI https://mailing.rss-fb.com/login` aus und prüft auf X-Frame-Options oder Content-Security-Policy frame-ancestors. Empfohlene Quellkorrektur unabhängig davon: in der Middleware für Nicht-GET/HEAD außerhalb von /api/cron und /api/integration Sec-Fetch-Site (nur same-origin/none) bzw. Origin == öffentliche App-Origin erzwingen, Cookie auf __Host-ml_session umstellen und frame-ancestors 'self' bzw. X-Frame-Options DENY über next.config.mjs headers() setzen.
