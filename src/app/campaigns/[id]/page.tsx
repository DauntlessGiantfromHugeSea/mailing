import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { Toasts } from "@/components/Toasts";
import { CampaignBadge, JobBadge } from "@/components/StatusBadge";
import { AutoRefresh } from "@/components/AutoRefresh";
import { prisma } from "@/lib/db";
import { canEdit } from "@/lib/rbac";
import { campaignProgress } from "@/lib/campaigns";
import { formatInZone, parseDays, formatMinuteOfDay } from "@/lib/sendWindow";
import { formatDays } from "@/lib/dayLabels";
import { safeDecrypt } from "@/lib/crypto";

export const dynamic = "force-dynamic";

const JOB_TABS = ["PENDING", "SENT", "FAILED", "SKIPPED"] as const;

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { ok?: string; error?: string; tab?: string };
}) {
  const s = await getSession();
  if (!s) redirect("/login");

  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    include: {
      list: { select: { name: true } },
      senders: { include: { sender: { select: { id: true, email: true, active: true } } } },
    },
  });
  if (!campaign) notFound();

  const progress = await campaignProgress(campaign.id);
  const tab = (JOB_TABS as readonly string[]).includes(searchParams.tab ?? "")
    ? (searchParams.tab as (typeof JOB_TABS)[number])
    : "PENDING";

  const jobs = await prisma.sendJob.findMany({
    where: { campaignId: campaign.id, status: tab },
    orderBy: tab === "SENT" ? { sentAt: "desc" } : { scheduledAt: "asc" },
    take: 60,
    include: {
      contact: true,
      sender: { select: { email: true } },
    },
  });

  const editable = canEdit(s);
  const isLive = campaign.status === "RUNNING" || campaign.status === "SCHEDULED";
  const tags: string[] = campaign.tagFilter ? safeArray(campaign.tagFilter) : [];

  return (
    <Shell session={s} active="campaigns">
      {/* Laufende Kampagne: Seite regelmäßig neu laden, damit die
          Warteschlange live mitläuft. */}
      {isLive && <AutoRefresh seconds={20} />}

      <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h1 className="text-2xl font-semibold truncate">{campaign.name}</h1>
            <CampaignBadge status={campaign.status} />
          </div>
          <p className="text-sm text-slate-600 mt-1.5">{campaign.subject}</p>
        </div>
        <Link href="/campaigns" className="btn-secondary">
          Zurück
        </Link>
      </div>

      <Toasts ok={searchParams.ok} error={searchParams.error} />

      {/* Fortschritt */}
      <div className="card p-5 mb-4 sm:mb-6">
        <div className="flex items-baseline justify-between mb-2">
          <span className="text-sm font-medium">
            {progress.sent} von {progress.total} gesendet
          </span>
          <span className="text-sm font-semibold mono text-brand-700">{progress.percent}%</span>
        </div>
        <div className="progress mb-4">
          <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          <Fact label="Wartet" value={progress.pending} />
          <Fact label="Gesendet" value={progress.sent} tone="text-green-700" />
          <Fact label="Fehler" value={progress.failed} tone={progress.failed ? "text-red-600" : ""} />
          <Fact label="Übersprungen" value={progress.skipped} />
          <Fact
            label="Nächste"
            text={progress.nextAt ? formatInZone(progress.nextAt, campaign.timezone) : "—"}
          />
          <Fact
            label="Letzte"
            text={progress.lastSentAt ? formatInZone(progress.lastSentAt, campaign.timezone) : "—"}
          />
        </div>
      </div>

      {/* Steuerung */}
      {editable && (
        <div className="card p-5 mb-4 sm:mb-6">
          <h2 className="font-semibold mb-3">Steuerung</h2>
          <div className="action-bar">
            {(campaign.status === "DRAFT" || campaign.status === "PAUSED") && (
              <ActionButton id={campaign.id} action="plan" className="btn-secondary">
                Neu einplanen
              </ActionButton>
            )}
            {(campaign.status === "DRAFT" || campaign.status === "SCHEDULED") && (
              <ActionButton id={campaign.id} action="launch" className="btn-primary">
                Versand starten
              </ActionButton>
            )}
            {campaign.status === "RUNNING" && (
              <ActionButton id={campaign.id} action="pause" className="btn-secondary">
                Pausieren
              </ActionButton>
            )}
            {campaign.status === "PAUSED" && (
              <ActionButton id={campaign.id} action="resume" className="btn-primary">
                Fortsetzen
              </ActionButton>
            )}
            {["DRAFT", "SCHEDULED", "RUNNING", "PAUSED"].includes(campaign.status) && (
              <ActionButton id={campaign.id} action="cancel" className="btn-danger">
                Abbrechen
              </ActionButton>
            )}
          </div>
          {campaign.status === "DRAFT" && (
            <p className="hint">
              „Neu einplanen“ berechnet die Sendezeitpunkte, ohne zu senden. „Versand starten“ plant
              (falls nötig) und beginnt.
            </p>
          )}
        </div>
      )}

      <div className="grid lg:grid-cols-3 gap-4 sm:gap-6">
        {/* Konfiguration */}
        <div className="card p-5 space-y-4 h-fit">
          <h2 className="font-semibold">Konfiguration</h2>

          <Row label="Taktung">
            <span className="mono">
              {campaign.intervalMinutes} min ±{campaign.jitterPercent}%
            </span>
            <div className="text-xs text-slate-500 mt-0.5">
              {campaign.jitterPercent > 0
                ? `≈ ${round1((campaign.intervalMinutes * (100 - campaign.jitterPercent)) / 100)}–${round1(
                    (campaign.intervalMinutes * (100 + campaign.jitterPercent)) / 100
                  )} min Abstand`
                : "gleichmäßiger Takt ohne Streuung"}
            </div>
          </Row>

          <Row label="Reihenfolge">
            {campaign.shuffleRecipients ? "zufällig gemischt" : "Importreihenfolge"}
          </Row>

          <Row label="Sendefenster">
            {formatDays(parseDays(campaign.sendDays))}
            <div className="mono text-xs text-slate-500 mt-0.5">
              {formatMinuteOfDay(campaign.windowStartMinute)}–
              {formatMinuteOfDay(campaign.windowEndMinute)} ({campaign.timezone})
            </div>
          </Row>

          <Row label="Empfänger">
            {campaign.list ? campaign.list.name : "alle aktiven Kontakte"}
            {tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1.5">
                {tags.map((t) => (
                  <span key={t} className="badge bg-brand-50 text-brand-700">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </Row>

          <Row label="Absender">
            {campaign.senders.length === 0 ? (
              "alle aktiven"
            ) : (
              <div className="space-y-0.5">
                {campaign.senders.map((cs) => (
                  <div key={cs.id} className="text-sm truncate">
                    {cs.sender.email}
                    {!cs.sender.active && <span className="text-amber-700 text-xs"> (inaktiv)</span>}
                  </div>
                ))}
              </div>
            )}
          </Row>

          {campaign.randomSeed && (
            <Row label="Zufalls-Seed">
              <span className="mono text-xs">{campaign.randomSeed}</span>
              <div className="text-xs text-slate-500 mt-0.5">
                Legt Mischung und Abstände fest — gleicher Seed, gleicher Zeitplan.
              </div>
            </Row>
          )}
        </div>

        {/* Warteschlange */}
        <div className="lg:col-span-2 card overflow-hidden h-fit">
          <div className="px-5 pt-5 pb-3 flex items-center justify-between gap-3 flex-wrap">
            <h2 className="font-semibold">Warteschlange</h2>
            <div className="segmented">
              {JOB_TABS.map((t) => (
                <Link
                  key={t}
                  href={`/campaigns/${campaign.id}?tab=${t}`}
                  className="no-underline"
                  scroll={false}
                >
                  <span
                    className={
                      "inline-flex items-center rounded-[11px] px-3 py-1.5 text-sm font-medium transition " +
                      (tab === t
                        ? "bg-white text-brand-700 shadow-[0_1px_2px_rgba(15,23,42,0.08)]"
                        : "text-slate-600 hover:text-slate-900")
                    }
                  >
                    {TAB_LABEL[t]}
                    <span className="ml-1.5 text-[11px] text-slate-400 mono">
                      {countFor(progress, t)}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          </div>

          {jobs.length === 0 ? (
            <p className="text-sm text-slate-500 px-5 pb-6">Keine Einträge in dieser Ansicht.</p>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th className="w-10">#</th>
                  <th>Empfänger</th>
                  <th>{tab === "SENT" ? "Gesendet" : "Geplant"}</th>
                  <th>Absender</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {jobs.map((job, i) => {
                  const prev = i > 0 ? jobs[i - 1] : null;
                  const gapMin =
                    prev && tab === "PENDING"
                      ? round1((job.scheduledAt.getTime() - prev.scheduledAt.getTime()) / 60_000)
                      : null;
                  return (
                    <tr key={job.id}>
                      <td className="text-xs text-slate-400 mono">{job.sequence + 1}</td>
                      <td>
                        <div className="text-sm truncate max-w-[220px]">
                          {safeDecrypt(job.contact.email) ?? "—"}
                        </div>
                        {(safeDecrypt(job.contact.firstName) || safeDecrypt(job.contact.company)) && (
                          <div className="text-[11px] text-slate-500 truncate max-w-[220px]">
                            {[safeDecrypt(job.contact.firstName), safeDecrypt(job.contact.company)]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                        )}
                      </td>
                      <td className="mono text-xs whitespace-nowrap">
                        {formatInZone(
                          tab === "SENT" ? job.sentAt ?? job.scheduledAt : job.scheduledAt,
                          campaign.timezone
                        )}
                        {gapMin !== null && (
                          <span className="text-slate-400"> (+{gapMin} min)</span>
                        )}
                      </td>
                      <td className="text-xs truncate max-w-[160px]">{job.sender?.email ?? "—"}</td>
                      <td>
                        <JobBadge status={job.status} />
                        {job.error && (
                          <div
                            className="text-[11px] text-red-600 mt-1 max-w-[220px] truncate"
                            title={job.error}
                          >
                            {job.error}
                          </div>
                        )}
                        {job.providerStatus && (
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Hostinger: {job.providerStatus}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {jobs.length === 60 && (
            <p className="text-xs text-slate-400 px-5 py-3">Es werden die ersten 60 Einträge gezeigt.</p>
          )}
        </div>
      </div>
    </Shell>
  );
}

const TAB_LABEL: Record<string, string> = {
  PENDING: "Wartet",
  SENT: "Gesendet",
  FAILED: "Fehler",
  SKIPPED: "Übersprungen",
};

function countFor(p: { pending: number; sent: number; failed: number; skipped: number }, tab: string) {
  switch (tab) {
    case "PENDING":
      return p.pending;
    case "SENT":
      return p.sent;
    case "FAILED":
      return p.failed;
    default:
      return p.skipped;
  }
}

function Fact({
  label,
  value,
  text,
  tone = "",
}: {
  label: string;
  value?: number;
  text?: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl bg-white/60 border border-slate-900/[0.06] px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className={"mt-0.5 font-semibold mono " + (text ? "text-xs" : "text-lg ") + tone}>
        {text ?? value}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function ActionButton({
  id,
  action,
  className,
  children,
}: {
  id: string;
  action: string;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <form method="post" action={`/api/campaigns/${id}/actions`} className="contents">
      <input type="hidden" name="action" value={action} />
      <button type="submit" className={className}>
        {children}
      </button>
    </form>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
