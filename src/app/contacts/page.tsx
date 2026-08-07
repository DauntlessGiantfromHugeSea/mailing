import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { ContactBadge } from "@/components/StatusBadge";
import { prisma } from "@/lib/db";
import { canEdit } from "@/lib/rbac";
import { decryptContact } from "@/lib/contacts";
import { getApiToken } from "@/lib/hostinger";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string; page?: string; status?: string; list?: string };
}) {
  const s = await getSession();
  if (!s) redirect("/login");

  const page = Math.max(1, Number(searchParams.page ?? 1) || 1);
  const statusFilter = searchParams.status;
  const listFilter = searchParams.list;

  const where = {
    ...(statusFilter && statusFilter !== "ALL"
      ? { status: statusFilter as "ACTIVE" | "UNSUBSCRIBED" | "BOUNCED" | "COMPLAINED" | "SUPPRESSED" }
      : {}),
    ...(listFilter ? { memberships: { some: { listId: listFilter } } } : {}),
  };

  const [contacts, total, lists, counts, hasToken] = await Promise.all([
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: { memberships: { include: { list: { select: { name: true } } } } },
    }),
    prisma.contact.count({ where }),
    prisma.contactList.findMany({
      orderBy: { name: "asc" },
      include: { _count: { select: { memberships: true } } },
    }),
    prisma.contact.groupBy({ by: ["status"], _count: { _all: true } }),
    getApiToken().then(Boolean),
  ]);

  const countFor = (st: string) => counts.find((c) => c.status === st)?._count._all ?? 0;
  const totalAll = counts.reduce((sum, c) => sum + c._count._all, 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const editable = canEdit(s);

  return (
    <Shell session={s} active="contacts">
      <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Kontakte</h1>
          <p className="text-xs text-slate-500 mt-1">
            {totalAll} insgesamt · {countFor("ACTIVE")} aktiv · {countFor("UNSUBSCRIBED")} abgemeldet
            · {countFor("BOUNCED")} unzustellbar
          </p>
        </div>
      </div>

      <Toasts ok={searchParams.ok} error={searchParams.error} />

      {/* Filter */}
      <div className="card p-4 mb-4 sm:mb-6 flex flex-wrap gap-2 items-center">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500 mr-1">
          Filter
        </span>
        {[
          { v: "ALL", l: `Alle (${totalAll})` },
          { v: "ACTIVE", l: `Aktiv (${countFor("ACTIVE")})` },
          { v: "UNSUBSCRIBED", l: `Abgemeldet (${countFor("UNSUBSCRIBED")})` },
          { v: "BOUNCED", l: `Unzustellbar (${countFor("BOUNCED")})` },
        ].map((f) => (
          <Link
            key={f.v}
            href={`/contacts?status=${f.v}${listFilter ? `&list=${listFilter}` : ""}`}
            className={
              "badge " +
              ((statusFilter ?? "ALL") === f.v
                ? "bg-brand-500 text-white"
                : "bg-white/70 text-slate-600 hover:bg-white")
            }
          >
            {f.l}
          </Link>
        ))}

        {lists.length > 0 && (
          <>
            <span className="w-px h-5 bg-slate-900/10 mx-1" />
            <Link
              href={`/contacts?status=${statusFilter ?? "ALL"}`}
              className={
                "badge " +
                (!listFilter ? "bg-brand-500 text-white" : "bg-white/70 text-slate-600 hover:bg-white")
              }
            >
              Alle Listen
            </Link>
            {lists.map((l) => (
              <Link
                key={l.id}
                href={`/contacts?status=${statusFilter ?? "ALL"}&list=${l.id}`}
                className={
                  "badge " +
                  (listFilter === l.id
                    ? "bg-brand-500 text-white"
                    : "bg-white/70 text-slate-600 hover:bg-white")
                }
              >
                {l.name} ({l._count.memberships})
              </Link>
            ))}
          </>
        )}
      </div>

      {editable && (
        <div className="grid md:grid-cols-3 gap-4 sm:gap-6 mb-4 sm:mb-6">
          {/* CSV-Import */}
          <div className="card p-5 md:col-span-2">
            <h2 className="font-semibold mb-1">CSV importieren</h2>
            <p className="hint mb-4">
              Erkannte Spalten: <code>email</code>, <code>vorname</code>/<code>firstName</code>,{" "}
              <code>nachname</code>/<code>lastName</code>, <code>firma</code>/<code>company</code>,{" "}
              <code>tags</code>. Weitere Spalten werden als Platzhalter verfügbar. Trennzeichen
              Komma, Semikolon oder Tab.
            </p>
            <form
              method="post"
              action="/api/contacts/import"
              encType="multipart/form-data"
              className="space-y-3"
            >
              <div>
                <label className="label">CSV-Datei</label>
                <input type="file" name="file" accept=".csv,text/csv,text/plain" required className="input" />
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">In Liste aufnehmen</label>
                  <select name="listId" className="input">
                    <option value="">— keine —</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="label">oder neue Liste anlegen</label>
                  <input name="newListName" className="input" placeholder="z. B. Messe 2026" />
                </div>
              </div>
              <button className="btn-primary">Importieren</button>
            </form>
          </div>

          <div className="space-y-4 sm:space-y-6">
            {/* Einzelnen Kontakt anlegen */}
            <div className="card p-5">
              <h2 className="font-semibold mb-1">Kontakt hinzufügen</h2>
              <p className="hint mb-3">Für einzelne Adressen — ohne CSV.</p>
              <form method="post" action="/api/contacts" className="space-y-3">
                <input
                  name="email"
                  type="email"
                  required
                  className="input"
                  placeholder="adresse@firma.de"
                />
                <div className="grid grid-cols-2 gap-2">
                  <input name="firstName" className="input" placeholder="Vorname" />
                  <input name="lastName" className="input" placeholder="Nachname" />
                </div>
                <input name="company" className="input" placeholder="Firma (optional)" />
                <input name="tags" className="input" placeholder="Tags, kommagetrennt (optional)" />
                <select name="listId" className="input">
                  <option value="">— keiner Liste zuordnen —</option>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
                <input name="newListName" className="input" placeholder="oder neue Liste anlegen" />
                <button className="btn-primary w-full">Hinzufügen</button>
              </form>
            </div>

            {/* Neue Liste */}
            <div className="card p-5">
              <h2 className="font-semibold mb-3">Neue Liste</h2>
              <form method="post" action="/api/contacts/lists" className="space-y-3">
                <input name="name" required className="input" placeholder="Listenname" />
                <button className="btn-secondary w-full">Liste anlegen</button>
              </form>
            </div>

            {/* Aus Hostinger Reach */}
            <div className="card p-5">
              <h2 className="font-semibold mb-1">Aus Hostinger Reach</h2>
              <p className="hint mb-3">
                Übernimmt die Kontakte des Reach-Profils aus dem Hostinger-Konto.
              </p>
              {hasToken ? (
                <form method="post" action="/api/contacts/reach-import" className="space-y-3">
                  <select name="listId" className="input">
                    <option value="">— keiner Liste zuordnen —</option>
                    {lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                  <button className="btn-secondary w-full">Kontakte holen</button>
                </form>
              ) : (
                <p className="text-xs text-slate-500">
                  Benötigt ein API-Token unter{" "}
                  <Link href="/settings" className="text-brand-700 hover:underline">
                    Einstellungen
                  </Link>
                  .
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tabelle */}
      {contacts.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-slate-600">Keine Kontakte in dieser Ansicht.</p>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>E-Mail</th>
                <th>Name</th>
                <th>Firma</th>
                <th>Listen</th>
                <th>Tags</th>
                <th>Status</th>
                <th>Quelle</th>
                {editable && <th></th>}
              </tr>
            </thead>
            <tbody>
              {contacts.map((raw) => {
                const c = decryptContact(raw);
                return (
                  <tr key={c.id}>
                    <td className="text-sm">{c.emailPlain || "—"}</td>
                    <td className="text-sm">
                      {[c.firstNamePlain, c.lastNamePlain].filter(Boolean).join(" ") || "—"}
                    </td>
                    <td className="text-sm">{c.companyPlain || "—"}</td>
                    <td className="text-xs text-slate-500">
                      {raw.memberships.map((m) => m.list.name).join(", ") || "—"}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {c.tagList.length === 0 ? (
                          <span className="text-slate-400 text-xs">—</span>
                        ) : (
                          c.tagList.map((t) => (
                            <span key={t} className="badge bg-brand-50 text-brand-700">
                              {t}
                            </span>
                          ))
                        )}
                      </div>
                    </td>
                    <td>
                      <ContactBadge status={c.status} />
                      {c.bounceCount > 0 && (
                        <div className="text-[11px] text-red-600 mt-0.5">
                          {c.bounceCount}× Zustellfehler
                        </div>
                      )}
                    </td>
                    <td className="text-xs text-slate-500">{c.source ?? "—"}</td>
                    {editable && (
                      <td className="text-right">
                        <form
                          method="post"
                          action={`/api/contacts/${c.id}/actions`}
                          className="inline-flex gap-1.5"
                        >
                          {c.status === "ACTIVE" ? (
                            <button name="action" value="suppress" className="btn-row">
                              sperren
                            </button>
                          ) : (
                            <button name="action" value="reactivate" className="btn-row">
                              freigeben
                            </button>
                          )}
                          <button name="action" value="delete" className="btn-row btn-row-danger">
                            löschen
                          </button>
                        </form>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-2 mt-5">
          {page > 1 && (
            <Link
              href={`/contacts?page=${page - 1}&status=${statusFilter ?? "ALL"}${
                listFilter ? `&list=${listFilter}` : ""
              }`}
              className="btn-secondary"
            >
              Zurück
            </Link>
          )}
          <span className="text-sm text-slate-500 mono px-2">
            Seite {page} / {pageCount}
          </span>
          {page < pageCount && (
            <Link
              href={`/contacts?page=${page + 1}&status=${statusFilter ?? "ALL"}${
                listFilter ? `&list=${listFilter}` : ""
              }`}
              className="btn-secondary"
            >
              Weiter
            </Link>
          )}
        </div>
      )}
    </Shell>
  );
}
