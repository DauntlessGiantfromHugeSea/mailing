import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Logo } from "@/components/Logo";
import { localLoginEnabled, microsoftConfig } from "@/lib/authMicrosoft";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  if (await getSession()) redirect("/dashboard");

  const microsoft = microsoftConfig() !== null;
  const local = localLoginEnabled();

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <Logo className="h-9" />
        </div>

        <div className="card p-6 sm:p-7 space-y-5">
          <div>
            <h1 className="text-lg font-semibold">Anmelden</h1>
            <p className="text-xs text-slate-500 mt-1">Drip-Versand über Hostinger</p>
          </div>

          {searchParams.error && (
            <div className="toast-error">{decodeURIComponent(searchParams.error)}</div>
          )}
          {searchParams.ok && <div className="toast-ok">{decodeURIComponent(searchParams.ok)}</div>}

          {/* Microsoft zuerst: wenn beides aktiv ist, soll das der Standardweg sein. */}
          {microsoft && (
            <a href="/api/auth/microsoft/start" className="btn-secondary w-full">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <rect x="0" y="0" width="7" height="7" fill="#F25022" />
                <rect x="9" y="0" width="7" height="7" fill="#7FBA00" />
                <rect x="0" y="9" width="7" height="7" fill="#00A4EF" />
                <rect x="9" y="9" width="7" height="7" fill="#FFB900" />
              </svg>
              Mit Microsoft anmelden
            </a>
          )}

          {microsoft && local && (
            <div className="flex items-center gap-3">
              <span className="h-px flex-1 bg-slate-900/10" />
              <span className="text-[11px] uppercase tracking-wider text-slate-400">oder</span>
              <span className="h-px flex-1 bg-slate-900/10" />
            </div>
          )}

          {local ? (
            <form action="/api/auth/login" method="post" className="space-y-4">
              <div>
                <label className="label" htmlFor="email">
                  E-Mail
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  autoComplete="username"
                  autoFocus={!microsoft}
                  className="input"
                />
              </div>

              <div>
                <label className="label" htmlFor="password">
                  Passwort
                </label>
                <input
                  id="password"
                  name="password"
                  type="password"
                  required
                  autoComplete="current-password"
                  className="input"
                />
              </div>

              <button type="submit" className="btn-primary w-full">
                Anmelden
              </button>
            </form>
          ) : (
            <p className="text-xs text-slate-500">
              Die Anmeldung mit Passwort ist deaktiviert. Zugang ausschließlich über Microsoft.
            </p>
          )}

          {!microsoft && !local && (
            <div className="toast-error">
              Es ist kein Anmeldeverfahren aktiv: die Passwortanmeldung ist per
              <code>AUTH_LOCAL_ENABLED=false</code> abgeschaltet, Microsoft ist aber nicht
              konfiguriert. Bitte <code>AUTH_LOCAL_ENABLED</code> in der <code>.env</code> wieder
              entfernen.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
