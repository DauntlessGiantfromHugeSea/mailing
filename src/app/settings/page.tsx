import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { isAdmin, roleLabel } from "@/lib/rbac";
import { getDefaults, getSetting, SETTINGS } from "@/lib/settings";
import { getApiToken } from "@/lib/hostinger";
import {
  checkDeliverability,
  diagnose,
  type DeliverabilityReport,
  type HostingerDiagnosis,
} from "@/lib/hostingerSync";
import { prisma } from "@/lib/db";
import { formatInZone } from "@/lib/sendWindow";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string; dns?: string; diag?: string };
}) {
  const s = await getSession();
  if (!s) redirect("/login");
  if (!isAdmin(s)) {
    // Mit Begründung umleiten. Eine stille Umleitung sieht wie ein Fehler aus -
    // der Benutzer sucht dann die Ursache bei sich oder in der App.
    redirect(
      "/dashboard?error=" +
        encodeURIComponent(
          `Die Einstellungen sind Administratoren vorbehalten. Deine Rolle ist ${roleLabel(s.role)}.`
        )
    );
  }

  const [token, defaults, reachProfile, mailOrder, recentAudit] = await Promise.all([
    getApiToken(),
    getDefaults(),
    getSetting(SETTINGS.reachProfileUuid),
    getSetting(SETTINGS.mailOrderId),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 15, include: { user: true } }),
  ]);

  // DNS-Check nur auf Klick — er ruft die Hostinger-API.
  let dns: DeliverabilityReport | null = null;
  let dnsError: string | null = null;
  if (searchParams.dns === "1" && token) {
    try {
      dns = await checkDeliverability();
    } catch (e) {
      dnsError = e instanceof Error ? e.message : String(e);
    }
  }

  // Diagnose ebenfalls nur auf Klick.
  let diag: HostingerDiagnosis | null = null;
  if (searchParams.diag === "1" && token) {
    try {
      diag = await diagnose();
    } catch (e) {
      dnsError = e instanceof Error ? e.message : String(e);
    }
  }

  return (
    <Shell session={s} active="settings">
      <h1 className="text-2xl font-semibold mb-6">Einstellungen</h1>

      <Toasts ok={searchParams.ok} error={searchParams.error ?? dnsError ?? undefined} />

      <div className="grid lg:grid-cols-2 gap-4 sm:gap-6 items-start">
        {/* Hostinger-API */}
        <div className="card p-5 space-y-4">
          <div>
            <h2 className="font-semibold">Hostinger-API</h2>
            <p className="hint">
              Token aus dem hPanel unter <em>Konto → API</em>. Er wird verschlüsselt gespeichert.
            </p>
          </div>

          <div className="toast-info text-[13px]">
            <span>
              Wichtig zur Einordnung: die Hostinger-API hat keinen Endpunkt zum <em>Versenden</em>{" "}
              von E-Mails. Der Versand läuft über SMTP (siehe „Absender“). Das Token wird gebraucht,
              um Postfächer einzulesen, Plan-Limits zu ermitteln, SPF/DKIM zu prüfen und die
              Zustell-Logs abzugleichen.
            </span>
          </div>

          <form method="post" action="/api/settings/hostinger" className="space-y-3">
            <div>
              <label className="label" htmlFor="apiToken">
                API-Token
              </label>
              <input
                id="apiToken"
                name="apiToken"
                type="password"
                className="input"
                autoComplete="off"
                placeholder={token ? "••••••••  (hinterlegt — zum Ersetzen neu eingeben)" : "Token einfügen"}
              />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <label className="label" htmlFor="reachProfileUuid">
                  Reach-Profil-UUID
                </label>
                <input
                  id="reachProfileUuid"
                  name="reachProfileUuid"
                  className="input"
                  defaultValue={reachProfile ?? ""}
                  placeholder="leer = automatisch"
                />
              </div>
              <div>
                <label className="label" htmlFor="mailOrderId">
                  Mail-Order-ID
                </label>
                <input
                  id="mailOrderId"
                  name="mailOrderId"
                  className="input"
                  defaultValue={mailOrder ?? ""}
                  placeholder="leer = automatisch"
                />
              </div>
            </div>
            <div className="action-bar">
              <button name="intent" value="save" className="btn-primary">
                Speichern
              </button>
              <button name="intent" value="test" className="btn-secondary">
                Verbindung testen
              </button>
              {token && (
                <button name="intent" value="clear" className="btn-secondary">
                  Token entfernen
                </button>
              )}
            </div>
          </form>
        </div>

        {/* Hostinger-Diagnose */}
        <div className="card p-5 space-y-4 lg:col-span-2">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="font-semibold">Was findet die API im Konto?</h2>
              <p className="hint">
                Zeigt Mail-Bestellungen, Postfächer und Reach-Profile. Hilfreich, wenn „Postfächer
                laden“ oder der Kontakt-Import leer bleibt — dann ist hier zu sehen, ob es an
                Token, Produkt oder Berechtigung liegt.
              </p>
            </div>
            {token && (
              <a href="/settings?diag=1" className="btn-secondary shrink-0">
                Konto prüfen
              </a>
            )}
          </div>

          {!token && <p className="text-sm text-slate-500">Benötigt ein hinterlegtes API-Token.</p>}

          {diag && (
            <>
              <div className="space-y-2">
                {diag.findings.map((f, i) => (
                  <div
                    key={i}
                    className={
                      f.level === "ok" ? "toast-ok" : f.level === "warn" ? "toast-warn" : "toast-info"
                    }
                  >
                    <span className="text-[13px]">{f.text}</span>
                  </div>
                ))}
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                    Mail-Bestellungen
                  </div>
                  {diag.mailOrders.length === 0 ? (
                    <p className="text-sm text-slate-500">keine</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {diag.mailOrders.map((o) => (
                        <li
                          key={o.id}
                          className="rounded-lg bg-white/60 border border-slate-900/[0.06] px-3 py-2"
                        >
                          <div className="text-sm font-medium">{o.domain}</div>
                          <div className="text-[11px] text-slate-500 mono">
                            {o.status} ·{" "}
                            {o.mailboxes < 0 ? "Postfächer nicht lesbar" : `${o.mailboxes} Postfach/Postfächer`}
                          </div>
                          <div className="text-[10px] text-slate-400 mono break-all">
                            Order-ID: {o.id}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                    Reach-Profile
                  </div>
                  {diag.reachProfiles.length === 0 ? (
                    <p className="text-sm text-slate-500">keine</p>
                  ) : (
                    <ul className="space-y-1.5">
                      {diag.reachProfiles.map((p) => (
                        <li
                          key={p.uuid}
                          className="rounded-lg bg-white/60 border border-slate-900/[0.06] px-3 py-2"
                        >
                          <div className="text-sm font-medium">{p.name}</div>
                          <div className="text-[10px] text-slate-400 mono break-all">{p.uuid}</div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {diag.reachProfiles.length > 1 && (
                    <p className="hint">
                      Mehrere Profile: die gewünschte UUID oben unter „Reach-Profil-UUID“
                      eintragen. Bei einem einzigen Profil wird es automatisch benutzt.
                    </p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Deliverability */}
        <div className="card p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold">Zustellbarkeit</h2>
              <p className="hint">
                SPF, DKIM und DMARC der Absenderdomain. Ohne saubere Authentifizierung landet auch
                ein perfekt getakteter Versand im Spam.
              </p>
            </div>
            {token && (
              <a href="/settings?dns=1" className="btn-secondary shrink-0">
                Prüfen
              </a>
            )}
          </div>

          {!token && (
            <p className="text-sm text-slate-500">Benötigt ein hinterlegtes API-Token.</p>
          )}

          {dns && (
            <>
              {dns.profileName && (
                <p className="text-xs text-slate-500">Profil: {dns.profileName}</p>
              )}
              {dns.checks.length > 0 ? (
                <ul className="space-y-2">
                  {dns.checks.map((c) => (
                    <li
                      key={c.name}
                      className="flex items-start gap-2.5 rounded-xl bg-white/60 border border-slate-900/[0.06] px-3 py-2.5"
                    >
                      <span
                        className={
                          "mt-0.5 h-4 w-4 rounded-full shrink-0 flex items-center justify-center text-[10px] font-bold text-white " +
                          (c.ok === true ? "bg-green-600" : c.ok === false ? "bg-red-600" : "bg-slate-400")
                        }
                      >
                        {c.ok === true ? "✓" : c.ok === false ? "!" : "?"}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{c.name}</span>
                        {c.detail && (
                          <span className="block text-[11px] text-slate-500 break-all">{c.detail}</span>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {dns.warning && <div className="toast-warn">{dns.warning}</div>}
              {dns.allOk && <div className="toast-ok">Alle geprüften Einträge sind in Ordnung.</div>}
            </>
          )}

          <div className="border-t border-slate-900/[0.06] pt-4">
            <h3 className="text-sm font-semibold mb-1">Zustellung abgleichen</h3>
            <p className="hint mb-3">
              SMTP bestätigt nur die Annahme. Dieser Abgleich liest das Hostinger-Outbound-Log und
              markiert Mails, die dort als <em>Failed</em> stehen — inklusive Bounce-Zählung.
            </p>
            <form method="post" action="/api/settings/reconcile" className="action-bar">
              <select name="hoursBack" className="input max-w-[160px]" defaultValue="24">
                <option value="6">letzte 6 Stunden</option>
                <option value="24">letzte 24 Stunden</option>
                <option value="72">letzte 3 Tage</option>
              </select>
              <button className="btn-secondary" disabled={!token}>
                Jetzt abgleichen
              </button>
            </form>
          </div>
        </div>

        {/* Standardwerte */}
        <div className="card p-5 space-y-4">
          <div>
            <h2 className="font-semibold">Standardwerte für neue Kampagnen</h2>
            <p className="hint">Vorbelegung des Kampagnen-Formulars.</p>
          </div>
          <form method="post" action="/api/settings/defaults" className="grid sm:grid-cols-3 gap-3">
            <div>
              <label className="label" htmlFor="timezone">
                Zeitzone
              </label>
              <input id="timezone" name="timezone" className="input" defaultValue={defaults.timezone} />
            </div>
            <div>
              <label className="label" htmlFor="intervalMinutes">
                Abstand (min)
              </label>
              <input
                id="intervalMinutes"
                name="intervalMinutes"
                type="number"
                min={1}
                max={1440}
                className="input"
                defaultValue={defaults.intervalMinutes}
              />
            </div>
            <div>
              <label className="label" htmlFor="jitterPercent">
                Streuung (%)
              </label>
              <input
                id="jitterPercent"
                name="jitterPercent"
                type="number"
                min={0}
                max={100}
                className="input"
                defaultValue={defaults.jitterPercent}
              />
            </div>
            <div className="sm:col-span-3">
              <button className="btn-primary">Speichern</button>
            </div>
          </form>
        </div>

        {/* Verlauf */}
        <div className="card overflow-hidden">
          <h2 className="font-semibold px-5 pt-5 pb-3">Verlauf</h2>
          {recentAudit.length === 0 ? (
            <p className="text-sm text-slate-500 px-5 pb-5">Noch keine Einträge.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Zeit</th>
                  <th>Aktion</th>
                  <th>Detail</th>
                  <th>Benutzer</th>
                </tr>
              </thead>
              <tbody>
                {recentAudit.map((a) => (
                  <tr key={a.id}>
                    <td className="text-xs mono whitespace-nowrap">
                      {formatInZone(a.createdAt, defaults.timezone)}
                    </td>
                    <td className="text-xs font-medium">{a.action}</td>
                    <td className="text-xs text-slate-500 max-w-[220px] truncate" title={a.detail ?? ""}>
                      {a.detail ?? "—"}
                    </td>
                    <td className="text-xs text-slate-500">{a.user?.name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Shell>
  );
}
