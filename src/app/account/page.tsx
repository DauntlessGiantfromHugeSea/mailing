import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { roleLabel } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { getDefaults } from "@/lib/settings";
import { formatInZone } from "@/lib/sendWindow";

export const dynamic = "force-dynamic";

export default async function AccountPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string };
}) {
  const s = await getSession();
  if (!s) redirect("/login");

  const [user, defaults] = await Promise.all([
    prisma.user.findUnique({ where: { id: s.uid } }),
    getDefaults(),
  ]);

  // Steht RUN_SEED_ON_START noch auf 1, setzt der Container-Start das Passwort
  // wieder auf den Wert aus der .env zurueck. Genau die Falle, die man erst
  // beim naechsten Neustart merkt - deshalb hier sichtbar machen.
  const seedOnStart = process.env.RUN_SEED_ON_START === "1";

  return (
    <Shell session={s} active="account">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold">Mein Konto</h1>
        <p className="text-xs text-slate-500 mt-1">
          {s.email} · {roleLabel(s.role)}
          {user?.lastLoginAt && ` · letzte Anmeldung ${formatInZone(user.lastLoginAt, defaults.timezone)}`}
        </p>
      </div>

      <Toasts ok={searchParams.ok} error={searchParams.error} />

      {seedOnStart && (
        <div className="toast-warn mb-6">
          <span>
            <strong>RUN_SEED_ON_START steht auf 1.</strong> Solange das so ist, wird dieses Passwort
            beim nächsten Neustart des Containers auf den Wert aus der <code>.env</code>{" "}
            zurückgesetzt. Auf dem Server entfernen mit:
            <br />
            <code className="text-[11px]">
              sed -i &apos;/^RUN_SEED_ON_START=/d&apos; .env &amp;&amp; docker compose up -d app
            </code>
          </span>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-4 sm:gap-6 items-start">
        <div className="card p-5">
          <h2 className="font-semibold mb-1">Passwort ändern</h2>
          <p className="hint mb-4">
            Mindestens 12 Zeichen. Nach der Änderung gilt das neue Passwort beim nächsten Anmelden.
          </p>

          <form method="post" action="/api/account/password" className="space-y-4">
            <div>
              <label className="label" htmlFor="currentPassword">
                Aktuelles Passwort
              </label>
              <input
                id="currentPassword"
                name="currentPassword"
                type="password"
                required
                autoComplete="current-password"
                className="input"
              />
            </div>

            <div>
              <label className="label" htmlFor="newPassword">
                Neues Passwort
              </label>
              <input
                id="newPassword"
                name="newPassword"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                className="input"
              />
            </div>

            <div>
              <label className="label" htmlFor="confirmPassword">
                Neues Passwort wiederholen
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                required
                minLength={12}
                autoComplete="new-password"
                className="input"
              />
            </div>

            <button type="submit" className="btn-primary">
              Passwort ändern
            </button>
          </form>
        </div>

        <div className="card p-5">
          <h2 className="font-semibold mb-3">Konto</h2>
          <dl className="space-y-3 text-sm">
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Name
              </dt>
              <dd>{s.name}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                E-Mail
              </dt>
              <dd>{s.email}</dd>
            </div>
            <div>
              <dt className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">
                Rolle
              </dt>
              <dd>{roleLabel(s.role)}</dd>
            </div>
          </dl>

          <p className="hint mt-4">
            Weitere Benutzer anzulegen oder Rollen zu ändern, ist in der Oberfläche noch nicht
            möglich. Das Datenmodell unterstützt es bereits (ADMIN / EDITOR / VIEWER) — es fehlt nur
            die Verwaltungsseite.
          </p>
        </div>
      </div>
    </Shell>
  );
}
