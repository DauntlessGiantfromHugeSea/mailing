import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: { error?: string; ok?: string };
}) {
  if (await getSession()) redirect("/dashboard");

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-6">
          <Logo className="h-9" />
        </div>

        <form action="/api/auth/login" method="post" className="card p-6 sm:p-7 space-y-4">
          <div>
            <h1 className="text-lg font-semibold">Anmelden</h1>
            <p className="text-xs text-slate-500 mt-1">Drip-Versand über Hostinger</p>
          </div>

          {searchParams.error && (
            <div className="toast-error">{decodeURIComponent(searchParams.error)}</div>
          )}
          {searchParams.ok && <div className="toast-ok">{decodeURIComponent(searchParams.ok)}</div>}

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
              autoFocus
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
      </div>
    </div>
  );
}
