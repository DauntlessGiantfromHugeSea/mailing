import { unsubscribeByToken } from "@/lib/contacts";
import { Logo } from "@/components/Logo";

export const dynamic = "force-dynamic";

// Oeffentliche Abmeldeseite (List-Unsubscribe-Ziel).
//
// Die Abmeldung wird direkt beim Aufruf ausgefuehrt, nicht erst nach einem
// zweiten Klick: Mail-Clients und Spamfilter rufen One-Click-Unsubscribe-Links
// teils automatisch auf, und eine Abmeldung soll in jedem Fall greifen.

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const token = searchParams.token?.trim();
  const contact = token ? await unsubscribeByToken(token) : null;

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <Logo className="h-9" />
        </div>

        <div className="card p-7 text-center">
          {contact ? (
            <>
              <div className="mx-auto h-12 w-12 rounded-full bg-green-100 flex items-center justify-center mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#166534"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h1 className="text-lg font-semibold">Sie sind abgemeldet</h1>
              <p className="text-sm text-slate-600 mt-2">
                Ihre Adresse wurde aus dem Verteiler entfernt. Bereits eingeplante Mails an Sie
                wurden zurückgezogen — Sie erhalten keine weiteren Nachrichten.
              </p>
            </>
          ) : (
            <>
              <div className="mx-auto h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center mb-4">
                <svg
                  width="24"
                  height="24"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#92400e"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                >
                  <path d="M12 8v5M12 16.5v.5" />
                </svg>
              </div>
              <h1 className="text-lg font-semibold">Link nicht gültig</h1>
              <p className="text-sm text-slate-600 mt-2">
                Dieser Abmeldelink ist unbekannt oder wurde bereits verwendet. Falls Sie weiterhin
                Nachrichten erhalten, antworten Sie einfach auf eine der E-Mails.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
