import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { CampaignBadge } from "@/components/StatusBadge";
import { prisma } from "@/lib/db";
import { canEdit } from "@/lib/rbac";
import { formatInZone, parseDays } from "@/lib/sendWindow";
import { formatDays } from "@/lib/dayLabels";

export const dynamic = "force-dynamic";

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string };
}) {
  const s = await getSession();
  if (!s) redirect("/login");

  const campaigns = await prisma.campaign.findMany({
    orderBy: [{ updatedAt: "desc" }],
    include: { list: { select: { name: true } } },
  });

  return (
    <Shell session={s} active="campaigns">
      <div className="flex items-center justify-between gap-3 mb-6">
        <h1 className="text-2xl font-semibold">Kampagnen</h1>
        {canEdit(s) && (
          <Link href="/campaigns/new" className="btn-primary">
            Neue Kampagne
          </Link>
        )}
      </div>

      <Toasts ok={searchParams.ok} error={searchParams.error} />

      {campaigns.length === 0 ? (
        <div className="card p-10 text-center">
          <p className="text-slate-600">Noch keine Kampagne angelegt.</p>
          <p className="text-sm text-slate-500 mt-2 max-w-md mx-auto">
            Eine Kampagne verschickt nicht sofort: sie verteilt die Mails randomisiert im
            Minutentakt über das eingestellte Sendefenster.
          </p>
          {canEdit(s) && (
            <Link href="/campaigns/new" className="btn-primary mt-5">
              Erste Kampagne anlegen
            </Link>
          )}
        </div>
      ) : (
        <div className="card overflow-hidden">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Fortschritt</th>
                <th>Taktung</th>
                <th>Fenster</th>
                <th>Zuletzt</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const done = c.sentCount + c.failedCount + c.skippedCount;
                const pct = c.recipientCount > 0 ? Math.round((done / c.recipientCount) * 100) : 0;
                return (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                      <div className="text-xs text-slate-500 truncate max-w-[280px]">
                        {c.subject}
                      </div>
                      {c.list && (
                        <div className="text-[11px] text-slate-400 mt-0.5">Liste: {c.list.name}</div>
                      )}
                    </td>
                    <td>
                      <CampaignBadge status={c.status} />
                    </td>
                    <td className="min-w-[140px]">
                      <div className="progress">
                        <div className="progress-bar" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 mono">
                        {c.sentCount} gesendet
                        {c.failedCount > 0 && (
                          <span className="text-red-600"> · {c.failedCount} Fehler</span>
                        )}
                        {c.recipientCount > 0 && ` · ${c.recipientCount} total`}
                      </div>
                    </td>
                    <td className="mono text-xs whitespace-nowrap">
                      {c.intervalMinutes} min ±{c.jitterPercent}%
                    </td>
                    <td className="text-xs whitespace-nowrap">
                      {formatDays(parseDays(c.sendDays))}
                      <div className="text-slate-500 mono">
                        {pad(c.windowStartMinute)}–{pad(c.windowEndMinute)}
                      </div>
                    </td>
                    <td className="text-xs mono whitespace-nowrap">
                      {formatInZone(c.finishedAt ?? c.startedAt ?? c.updatedAt, c.timezone)}
                    </td>
                    <td className="text-right">
                      <Link href={`/campaigns/${c.id}`} className="btn-row">
                        öffnen
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Shell>
  );
}

function pad(minute: number): string {
  const h = Math.floor(minute / 60);
  return `${String(h).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
