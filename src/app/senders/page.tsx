import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { prisma } from "@/lib/db";
import { canEdit } from "@/lib/rbac";
import { loadSenderStats, warmupDay, effectiveDailyLimit } from "@/lib/senders";
import { getApiToken } from "@/lib/hostinger";
import { discoverMailboxes, type DiscoveredMailbox } from "@/lib/hostingerSync";
import { formatInZone } from "@/lib/sendWindow";
import { getDefaults } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function SendersPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string; discover?: string };
}) {
  const s = await getSession();
  if (!s) redirect("/login");

  const [senders, defaults, hasToken] = await Promise.all([
    prisma.sender.findMany({ orderBy: { createdAt: "asc" } }),
    getDefaults(),
    getApiToken().then(Boolean),
  ]);
  const stats = await loadSenderStats(senders);
  const editable = canEdit(s);

  // Postfach-Suche nur auf ausdrücklichen Klick — sonst würde jeder
  // Seitenaufruf die Hostinger-API abfragen.
  let discovered: DiscoveredMailbox[] | null = null;
  let discoverError: string | null = null;
  if (searchParams.discover === "1" && hasToken) {
    try {
      discovered = await discoverMailboxes();
    } catch (e) {
      discoverError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <Shell session={s} active="senders">
      <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Absender</h1>
          <p className="text-xs text-slate-500 mt-1 max-w-2xl">
            Jeder Absender ist ein Postfach mit SMTP-Zugang — bei Hostinger, all-inkl oder
            einem anderen Anbieter. Mehrere Postfächer verteilen das Volumen (Inbox-Rotation) und
            halten jedes einzelne unter seinem Tageslimit.
          </p>
        </div>
        {editable && hasToken && (
          <a href="/senders?discover=1" className="btn-secondary">
            Postfächer aus Hostinger laden
          </a>
        )}
      </div>

      <Toasts ok={searchParams.ok} error={searchParams.error ?? discoverError ?? undefined} />

      {!hasToken && (
        <div className="toast-info mb-6">
          <span>
            Kein Hostinger-API-Token hinterlegt. Absender können trotzdem manuell angelegt werden —
            mit Token lassen sich die Postfächer automatisch einlesen (unter „Einstellungen“).
          </span>
        </div>
      )}

      {/* --- Aus Hostinger geladene Postfächer --- */}
      {discovered && (
        <div className="card p-5 mb-6">
          <h2 className="font-semibold mb-1">Postfächer im Hostinger-Konto</h2>
          <p className="hint mb-4">
            Das SMTP-Passwort kann die API aus Sicherheitsgründen nicht liefern — es muss einmal
            eingetragen werden. Alles andere ist vorbefüllt.
          </p>

          {discovered.length === 0 ? (
            <div className="toast-warn">
              <span>
                <strong>Keine Postfächer im Hostinger-Konto.</strong> Das ist kein Fehler dieser
                Seite — es liegt dort keine Mail-Bestellung, also gibt es auch keine Postfächer zum
                Einlesen. Was die API tatsächlich antwortet, steht unter{" "}
                <Link href="/settings?diag=1" className="underline font-medium">
                  Einstellungen → Konto prüfen
                </Link>
                .
                <br />
                <br />
                Absender bitte unten unter <strong>„Absender manuell anlegen“</strong> eintragen.
                Der Versand läuft über SMTP und ist nicht an Hostinger gebunden — ein Postfach bei
                all-inkl funktioniert genauso.
              </span>
            </div>
          ) : (
            <div className="space-y-3">
              {discovered.map((mb) => (
                <details key={mb.mailboxId} className="rounded-xl bg-white/60 border border-slate-900/[0.08]">
                  <summary className="cursor-pointer px-4 py-3 flex items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block text-sm font-medium truncate">{mb.email}</span>
                      <span className="block text-[11px] text-slate-500">
                        {mb.domain}
                        {mb.planDailyLimit !== null && ` · Plan-Limit ${mb.planDailyLimit}/Tag`}
                      </span>
                    </span>
                    {mb.alreadyImported ? (
                      <span className="badge bg-green-100 text-green-800 shrink-0">übernommen</span>
                    ) : (
                      <span className="badge bg-slate-100 text-slate-600 shrink-0">
                        hinzufügen
                      </span>
                    )}
                  </summary>

                  <form
                    method="post"
                    action="/api/senders/import"
                    className="px-4 pb-4 pt-1 grid sm:grid-cols-2 gap-3"
                  >
                    <input type="hidden" name="orderId" value={mb.orderId} />
                    <input type="hidden" name="mailboxId" value={mb.mailboxId} />
                    <input type="hidden" name="email" value={mb.email} />

                    <div>
                      <label className="label">Absendername</label>
                      <input name="fromName" className="input" required placeholder="Ihr Firmenname" />
                    </div>
                    <div>
                      <label className="label">SMTP-Passwort</label>
                      <input
                        name="smtpPassword"
                        type="password"
                        className="input"
                        required
                        autoComplete="new-password"
                      />
                    </div>
                    <div>
                      <label className="label">Tageslimit</label>
                      <input
                        name="dailyLimit"
                        type="number"
                        min={1}
                        max={5000}
                        className="input"
                        defaultValue={mb.planDailyLimit ?? 40}
                      />
                    </div>
                    <div>
                      <label className="label">Antwort-an (optional)</label>
                      <input name="replyTo" type="email" className="input" />
                    </div>
                    <div className="sm:col-span-2 flex items-center justify-between gap-3 flex-wrap">
                      <label className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          name="warmupEnabled"
                          value="1"
                          defaultChecked
                          className="accent-brand-500 h-4 w-4"
                        />
                        Warmup aktivieren (langsam hochfahren)
                      </label>
                      <button className="btn-primary">
                        {mb.alreadyImported ? "Zugangsdaten aktualisieren" : "Als Absender übernehmen"}
                      </button>
                    </div>
                  </form>
                </details>
              ))}
            </div>
          )}
        </div>
      )}

      {/* --- Vorhandene Absender --- */}
      {senders.length === 0 ? (
        <div className="card p-10 text-center mb-6">
          <p className="text-slate-600">Noch kein Absender eingerichtet.</p>
          <p className="text-sm text-slate-500 mt-2">Ohne Postfach kann nicht gesendet werden.</p>
        </div>
      ) : (
        <div className="card overflow-hidden mb-6">
          <table className="table">
            <thead>
              <tr>
                <th>Postfach</th>
                <th>SMTP</th>
                <th>Heute</th>
                <th>Warmup</th>
                <th>Verbindung</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {stats.map((x) => {
                const snd = x.sender;
                const wd = warmupDay(snd);
                return (
                  <tr key={snd.id}>
                    <td>
                      <div className="text-sm font-medium">{snd.email}</div>
                      <div className="text-[11px] text-slate-500">
                        {snd.fromName}
                        {snd.hostingerMailboxId && " · aus Hostinger"}
                        {!snd.active && (
                          <span className="text-amber-700 font-medium"> · inaktiv</span>
                        )}
                      </div>
                    </td>
                    <td className="text-xs mono whitespace-nowrap">
                      {snd.smtpHost}:{snd.smtpPort}
                      <div className="text-slate-400">{snd.smtpSecure ? "SSL" : "STARTTLS"}</div>
                    </td>
                    <td className="min-w-[120px]">
                      <div className="progress">
                        <div
                          className="progress-bar"
                          style={{
                            width: `${x.limit > 0 ? Math.min(100, (x.sentToday / x.limit) * 100) : 0}%`,
                          }}
                        />
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 mono">
                        {x.sentToday}/{x.limit} · {x.remaining} frei
                      </div>
                    </td>
                    <td className="text-xs whitespace-nowrap">
                      {snd.warmupEnabled ? (
                        wd !== null ? (
                          <>
                            Tag {wd}
                            <div className="text-slate-500 mono">
                              {effectiveDailyLimit(snd)} / {snd.dailyLimit}
                            </div>
                          </>
                        ) : (
                          <span className="text-slate-500">startet mit {snd.warmupStart}</span>
                        )
                      ) : (
                        <span className="text-slate-400">aus</span>
                      )}
                    </td>
                    <td className="text-xs whitespace-nowrap">
                      {snd.lastCheckAt ? (
                        <>
                          <span className={snd.lastCheckOk ? "text-green-700" : "text-red-600"}>
                            {snd.lastCheckOk ? "OK" : "Fehler"}
                          </span>
                          <div className="text-slate-400 mono">
                            {formatInZone(snd.lastCheckAt, defaults.timezone)}
                          </div>
                          {!snd.lastCheckOk && snd.lastCheckError && (
                            <div className="text-red-600 max-w-[200px] truncate" title={snd.lastCheckError}>
                              {snd.lastCheckError}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-400">nicht geprüft</span>
                      )}
                    </td>
                    <td className="text-right">
                      {editable && (
                        <div className="flex justify-end gap-1.5 flex-wrap">
                          <SmallAction id={snd.id} action="verify" label="testen" />
                          <SmallAction
                            id={snd.id}
                            action="toggle"
                            label={snd.active ? "deaktivieren" : "aktivieren"}
                          />
                          <SmallAction id={snd.id} action="delete" label="löschen" danger />
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* --- Manuell anlegen --- */}
      {editable && (
        <details className="card p-5">
          <summary className="cursor-pointer font-semibold">Absender manuell anlegen</summary>
          <form method="post" action="/api/senders" className="grid sm:grid-cols-2 gap-3 mt-4">
            <div>
              <label className="label">Absenderadresse</label>
              <input name="email" type="email" required className="input" placeholder="info@ihre-domain.de" />
            </div>
            <div>
              <label className="label">Absendername</label>
              <input name="fromName" required className="input" placeholder="Ihr Firmenname" />
            </div>
            <div>
              <label className="label">SMTP-Server</label>
              <input name="smtpHost" className="input" defaultValue="smtp.hostinger.com" />
              <p className="hint">
                Hostinger: <code>smtp.hostinger.com</code> · all-inkl:{" "}
                <code>w0…​.kasserver.com</code> (steht im KAS beim Postfach) · andere Anbieter
                entsprechend.
              </p>
            </div>
            <div>
              <label className="label">Port</label>
              <select name="smtpPort" className="input" defaultValue="465">
                <option value="465">465 (SSL)</option>
                <option value="587">587 (STARTTLS)</option>
              </select>
            </div>
            <div>
              <label className="label">SMTP-Benutzer</label>
              <input name="smtpUser" className="input" placeholder="leer = Absenderadresse" />
            </div>
            <div>
              <label className="label">SMTP-Passwort</label>
              <input name="smtpPassword" type="password" required className="input" autoComplete="new-password" />
            </div>
            <div>
              <label className="label">Tageslimit</label>
              <input name="dailyLimit" type="number" min={1} max={5000} className="input" defaultValue={40} />
            </div>
            <div>
              <label className="label">Antwort-an (optional)</label>
              <input name="replyTo" type="email" className="input" />
            </div>
            <div className="sm:col-span-2 flex items-center justify-between gap-3 flex-wrap pt-1">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="warmupEnabled" value="1" defaultChecked className="accent-brand-500 h-4 w-4" />
                Warmup aktivieren
              </label>
              <button className="btn-primary">Absender anlegen</button>
            </div>
          </form>
        </details>
      )}
    </Shell>
  );
}

function SmallAction({
  id,
  action,
  label,
  danger,
}: {
  id: string;
  action: string;
  label: string;
  danger?: boolean;
}) {
  return (
    <form method="post" action={`/api/senders/${id}/actions`} className="contents">
      <input type="hidden" name="action" value={action} />
      <button type="submit" className={"btn-row " + (danger ? "btn-row-danger" : "")}>
        {label}
      </button>
    </form>
  );
}
