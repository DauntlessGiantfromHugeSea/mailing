import Link from "next/link";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { CampaignBadge } from "@/components/StatusBadge";
import { prisma } from "@/lib/db";
import { loadSenderStats, warmupDay } from "@/lib/senders";
import { formatInZone } from "@/lib/sendWindow";
import { getDefaults } from "@/lib/settings";
import { safeDecrypt } from "@/lib/crypto";

export const dynamic = "force-dynamic";
// Das Dashboard zeigt eine laufende Warteschlange - alle 20s neu laden.
export const revalidate = 0;

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: { ok?: string; error?: string };
}) {
  const s = await getSession();
  if (!s) redirect("/login");

  const { timezone } = await getDefaults();
  const today = startOfTodayUtc();

  const [
    sentToday,
    pendingTotal,
    failedToday,
    nextJobs,
    activeCampaigns,
    senders,
    contactCount,
    unsubCount,
    lastSent,
  ] = await Promise.all([
    prisma.sendJob.count({ where: { status: "SENT", sentAt: { gte: today } } }),
    prisma.sendJob.count({ where: { status: "PENDING", campaign: { status: { in: ["RUNNING", "SCHEDULED"] } } } }),
    prisma.sendJob.count({ where: { status: "FAILED", updatedAt: { gte: today } } }),
    prisma.sendJob.findMany({
      where: { status: "PENDING", campaign: { status: { in: ["RUNNING", "SCHEDULED"] } } },
      orderBy: { scheduledAt: "asc" },
      take: 12,
      include: { campaign: { select: { id: true, name: true, timezone: true } }, contact: true },
    }),
    prisma.campaign.findMany({
      where: { status: { in: ["RUNNING", "SCHEDULED", "PAUSED"] } },
      orderBy: { updatedAt: "desc" },
      take: 6,
    }),
    prisma.sender.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.contact.count({ where: { status: "ACTIVE" } }),
    prisma.contact.count({ where: { status: { in: ["UNSUBSCRIBED", "BOUNCED", "COMPLAINED", "SUPPRESSED"] } } }),
    prisma.sendJob.findFirst({
      where: { status: "SENT" },
      orderBy: { sentAt: "desc" },
      select: { sentAt: true },
    }),
  ]);

  const stats = await loadSenderStats(senders);
  const capacityToday = stats.reduce((sum, x) => sum + x.remaining, 0);
  const nextAt = nextJobs[0]?.scheduledAt ?? null;

  return (
    <Shell session={s} active="dashboard">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-xs text-slate-500 mt-1">Zeitzone {timezone}</p>
        </div>
        <Link href="/campaigns/new" className="btn-primary">
          Neue Kampagne
        </Link>
      </div>

      <Toasts ok={searchParams.ok} error={searchParams.error} />

      {/* KPI-Kacheln */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-6">
        <div className="stat">
          <div className="stat-label">Heute gesendet</div>
          <div className="stat-value">{sentToday}</div>
          <div className="stat-sub">
            {lastSent?.sentAt ? `zuletzt ${formatInZone(lastSent.sentAt, timezone)}` : "noch keine Mail heute"}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">In Warteschlange</div>
          <div className="stat-value">{pendingTotal}</div>
          <div className="stat-sub">
            {nextAt ? `nächste ${formatInZone(nextAt, timezone)}` : "keine Sendung geplant"}
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Kapazität heute</div>
          <div className="stat-value">{capacityToday}</div>
          <div className="stat-sub">
            {stats.length} Absender · {stats.filter((x) => x.remaining === 0).length} am Limit
          </div>
        </div>
        <div className="stat">
          <div className="stat-label">Fehler heute</div>
          <div className={"stat-value " + (failedToday > 0 ? "text-red-600" : "")}>{failedToday}</div>
          <div className="stat-sub">
            {contactCount} aktive Kontakte · {unsubCount} gesperrt
          </div>
        </div>
      </div>

      {senders.length === 0 && (
        <div className="toast-warn mb-6">
          <span>
            Noch kein Absender eingerichtet. Ohne Postfach kann nicht gesendet werden —{" "}
            <Link href="/senders" className="underline font-medium">
              jetzt Absender anlegen
            </Link>
            .
          </span>
        </div>
      )}

      <div className="grid lg:grid-cols-5 gap-4 sm:gap-6">
        {/* Nächste geplante Sendungen */}
        <div className="lg:col-span-3 card p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-semibold">Nächste Sendungen</h2>
            <span className="text-xs text-slate-500">randomisierte Abstände</span>
          </div>

          {nextJobs.length === 0 ? (
            <p className="text-sm text-slate-500 py-6 text-center">
              Keine Sendungen eingeplant. Starte eine Kampagne, um die Warteschlange zu füllen.
            </p>
          ) : (
            <div className="timeline">
              {nextJobs.map((job, i) => {
                const prev = i > 0 ? nextJobs[i - 1].scheduledAt : null;
                const gapMin = prev
                  ? Math.round(((job.scheduledAt.getTime() - prev.getTime()) / 60_000) * 10) / 10
                  : null;
                return (
                  <div key={job.id} className="timeline-item">
                    <div className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <div className="mono text-sm text-slate-800">
                          {formatInZone(job.scheduledAt, job.campaign.timezone)}
                        </div>
                        <div className="text-xs text-slate-500 truncate">
                          {safeDecrypt(job.contact.email) ?? "—"} ·{" "}
                          <Link href={`/campaigns/${job.campaign.id}`} className="hover:underline">
                            {job.campaign.name}
                          </Link>
                        </div>
                      </div>
                      {gapMin !== null && (
                        <span className="badge bg-slate-100 text-slate-500 shrink-0 mono">
                          +{gapMin} min
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="lg:col-span-2 space-y-4 sm:space-y-6">
          {/* Aktive Kampagnen */}
          <div className="card p-5">
            <h2 className="font-semibold mb-4">Aktive Kampagnen</h2>
            {activeCampaigns.length === 0 ? (
              <p className="text-sm text-slate-500">Nichts aktiv.</p>
            ) : (
              <ul className="space-y-3">
                {activeCampaigns.map((c) => {
                  const done = c.sentCount + c.failedCount + c.skippedCount;
                  const pct = c.recipientCount > 0 ? Math.round((done / c.recipientCount) * 100) : 0;
                  return (
                    <li key={c.id}>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <Link href={`/campaigns/${c.id}`} className="text-sm font-medium hover:underline truncate">
                          {c.name}
                        </Link>
                        <CampaignBadge status={c.status} />
                      </div>
                      <div className="progress">
                        <div className="progress-bar" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 mono">
                        {done} / {c.recipientCount} · {pct}%
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {/* Absender-Auslastung */}
          <div className="card p-5">
            <div className="flex items-baseline justify-between mb-4">
              <h2 className="font-semibold">Absender heute</h2>
              <Link href="/senders" className="text-xs text-brand-700 hover:underline">
                verwalten
              </Link>
            </div>
            {stats.length === 0 ? (
              <p className="text-sm text-slate-500">Keine Absender.</p>
            ) : (
              <ul className="space-y-3">
                {stats.map((x) => {
                  const pct = x.limit > 0 ? Math.min(100, Math.round((x.sentToday / x.limit) * 100)) : 0;
                  const wd = warmupDay(x.sender);
                  return (
                    <li key={x.sender.id}>
                      <div className="flex items-center justify-between gap-2 mb-1.5">
                        <span className="text-sm truncate">{x.sender.email}</span>
                        <span className="text-xs text-slate-500 mono shrink-0">
                          {x.sentToday}/{x.limit}
                        </span>
                      </div>
                      <div className="progress">
                        <div
                          className="progress-bar"
                          style={{
                            width: `${pct}%`,
                            ...(pct >= 100 ? { background: "linear-gradient(90deg,#f59e0b,#d97706)" } : {}),
                          }}
                        />
                      </div>
                      {wd !== null && (
                        <div className="text-[11px] text-slate-500 mt-1">Warmup Tag {wd}</div>
                      )}
                      {!x.sender.active && (
                        <div className="text-[11px] text-amber-700 mt-1">inaktiv</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Shell>
  );
}
