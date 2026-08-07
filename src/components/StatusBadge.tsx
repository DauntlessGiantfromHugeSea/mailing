const CAMPAIGN: Record<string, { label: string; tone: string }> = {
  DRAFT: { label: "Entwurf", tone: "bg-slate-100 text-slate-600" },
  SCHEDULED: { label: "Geplant", tone: "bg-indigo-100 text-indigo-700" },
  RUNNING: { label: "Läuft", tone: "bg-blue-100 text-blue-800" },
  PAUSED: { label: "Pausiert", tone: "bg-amber-100 text-amber-800" },
  COMPLETED: { label: "Abgeschlossen", tone: "bg-green-100 text-green-800" },
  CANCELLED: { label: "Abgebrochen", tone: "bg-slate-100 text-slate-500" },
  FAILED: { label: "Fehlgeschlagen", tone: "bg-red-100 text-red-700" },
};

const JOB: Record<string, { label: string; tone: string }> = {
  PENDING: { label: "Wartet", tone: "bg-slate-100 text-slate-600" },
  SENDING: { label: "Sendet", tone: "bg-blue-100 text-blue-800" },
  SENT: { label: "Gesendet", tone: "bg-green-100 text-green-800" },
  FAILED: { label: "Fehler", tone: "bg-red-100 text-red-700" },
  SKIPPED: { label: "Übersprungen", tone: "bg-amber-100 text-amber-800" },
  CANCELLED: { label: "Abgebrochen", tone: "bg-slate-100 text-slate-500" },
};

const CONTACT: Record<string, { label: string; tone: string }> = {
  ACTIVE: { label: "Aktiv", tone: "bg-green-100 text-green-800" },
  UNSUBSCRIBED: { label: "Abgemeldet", tone: "bg-slate-100 text-slate-600" },
  BOUNCED: { label: "Unzustellbar", tone: "bg-red-100 text-red-700" },
  COMPLAINED: { label: "Beschwerde", tone: "bg-red-100 text-red-700" },
  SUPPRESSED: { label: "Gesperrt", tone: "bg-amber-100 text-amber-800" },
};

export function CampaignBadge({ status }: { status: string }) {
  const s = CAMPAIGN[status] ?? { label: status, tone: "bg-slate-100 text-slate-600" };
  return <span className={"badge " + s.tone}>{s.label}</span>;
}

export function JobBadge({ status }: { status: string }) {
  const s = JOB[status] ?? { label: status, tone: "bg-slate-100 text-slate-600" };
  return <span className={"badge " + s.tone}>{s.label}</span>;
}

export function ContactBadge({ status }: { status: string }) {
  const s = CONTACT[status] ?? { label: status, tone: "bg-slate-100 text-slate-600" };
  return <span className={"badge " + s.tone}>{s.label}</span>;
}
