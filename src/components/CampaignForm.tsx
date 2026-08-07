"use client";

import { useCallback, useEffect, useState } from "react";
import { DAY_LABELS } from "@/lib/dayLabels";

// Kampagnen-Formular mit Live-Vorschau der Taktung.
//
// Die Vorschau ruft /api/campaigns/preview auf, damit exakt dieselbe
// Planungslogik greift wie beim spaeteren Anlegen der Jobs - keine
// nachgebaute Naeherung im Browser.

export interface ListOption {
  id: string;
  name: string;
  count: number;
}

export interface SenderOption {
  id: string;
  label: string;
  email: string;
  remaining: number;
  limit: number;
  active: boolean;
}

export interface Defaults {
  timezone: string;
  intervalMinutes: number;
  jitterPercent: number;
}

interface PreviewResponse {
  recipientCount: number;
  first: string | null;
  last: string | null;
  avgGapMinutes: number;
  minGapMinutes: number;
  maxGapMinutes: number;
  spanDays: number;
  slots: { sequence: number; scheduledAt: string; gapSeconds: number }[];
  capacityToday: number;
  warning?: string;
  error?: string;
}

export interface CampaignFormValues {
  name: string;
  subject: string;
  bodyHtml: string;
  bodyText: string;
  listId: string;
  tagFilter: string;
  intervalMinutes: number;
  jitterPercent: number;
  shuffleRecipients: boolean;
  timezone: string;
  sendDays: number[];
  windowStart: string;
  windowEnd: string;
  senderIds: string[];
}

export function CampaignForm({
  action,
  lists,
  senders,
  defaults,
  initial,
  submitLabel,
  totalActiveContacts,
}: {
  action: string;
  lists: ListOption[];
  senders: SenderOption[];
  defaults: Defaults;
  initial?: Partial<CampaignFormValues>;
  submitLabel: string;
  totalActiveContacts: number;
}) {
  const [values, setValues] = useState<CampaignFormValues>({
    name: initial?.name ?? "",
    subject: initial?.subject ?? "",
    bodyHtml: initial?.bodyHtml ?? DEFAULT_BODY,
    bodyText: initial?.bodyText ?? "",
    listId: initial?.listId ?? "",
    tagFilter: initial?.tagFilter ?? "",
    intervalMinutes: initial?.intervalMinutes ?? defaults.intervalMinutes,
    jitterPercent: initial?.jitterPercent ?? defaults.jitterPercent,
    shuffleRecipients: initial?.shuffleRecipients ?? true,
    timezone: initial?.timezone ?? defaults.timezone,
    sendDays: initial?.sendDays ?? [1, 2, 3, 4, 5],
    windowStart: initial?.windowStart ?? "09:00",
    windowEnd: initial?.windowEnd ?? "17:00",
    senderIds: initial?.senderIds ?? [],
  });

  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const set = <K extends keyof CampaignFormValues>(key: K, v: CampaignFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: v }));

  const toggleDay = (day: number) =>
    setValues((prev) => ({
      ...prev,
      sendDays: prev.sendDays.includes(day)
        ? prev.sendDays.filter((d) => d !== day)
        : [...prev.sendDays, day].sort(),
    }));

  const toggleSender = (id: string) =>
    setValues((prev) => ({
      ...prev,
      senderIds: prev.senderIds.includes(id)
        ? prev.senderIds.filter((s) => s !== id)
        : [...prev.senderIds, id],
    }));

  const fetchPreview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/campaigns/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listId: values.listId || null,
          tagFilter: values.tagFilter,
          intervalMinutes: values.intervalMinutes,
          jitterPercent: values.jitterPercent,
          shuffleRecipients: values.shuffleRecipients,
          timezone: values.timezone,
          sendDays: values.sendDays,
          windowStart: values.windowStart,
          windowEnd: values.windowEnd,
          senderIds: values.senderIds,
        }),
      });
      setPreview((await res.json()) as PreviewResponse);
    } catch {
      setPreview(null);
    } finally {
      setLoading(false);
    }
  }, [
    values.listId,
    values.tagFilter,
    values.intervalMinutes,
    values.jitterPercent,
    values.shuffleRecipients,
    values.timezone,
    values.sendDays,
    values.windowStart,
    values.windowEnd,
    values.senderIds,
  ]);

  // Debounce, damit ein Schieberegler nicht pro Pixel eine Anfrage auslöst.
  useEffect(() => {
    const t = setTimeout(fetchPreview, 350);
    return () => clearTimeout(t);
  }, [fetchPreview]);

  const selectedList = lists.find((l) => l.id === values.listId);
  const recipientEstimate = selectedList ? selectedList.count : totalActiveContacts;

  return (
    <form method="post" action={action} className="grid lg:grid-cols-5 gap-4 sm:gap-6 items-start">
      {/* --------------------------------------------------- linke Spalte */}
      <div className="lg:col-span-3 space-y-4 sm:space-y-6">
        {/* Inhalt */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold">Inhalt</h2>

          <div>
            <label className="label" htmlFor="name">
              Interner Name
            </label>
            <input
              id="name"
              name="name"
              required
              className="input"
              value={values.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="z. B. Frühjahrs-Kampagne KW14"
            />
          </div>

          <div>
            <label className="label" htmlFor="subject">
              Betreff
            </label>
            <input
              id="subject"
              name="subject"
              required
              className="input"
              value={values.subject}
              onChange={(e) => set("subject", e.target.value)}
              placeholder="{Hallo|Guten Tag} {{firstName}}, kurze Frage"
            />
            <p className="hint">
              Platzhalter: <code>{"{{firstName}}"}</code> <code>{"{{lastName}}"}</code>{" "}
              <code>{"{{company}}"}</code>. Spintax <code>{"{A|B|C}"}</code> wählt pro Empfänger
              eine Variante — das verhindert, dass alle Mails identisch aussehen.
            </p>
          </div>

          <div>
            <label className="label" htmlFor="bodyHtml">
              HTML-Inhalt
            </label>
            <textarea
              id="bodyHtml"
              name="bodyHtml"
              required
              rows={14}
              className="input"
              value={values.bodyHtml}
              onChange={(e) => set("bodyHtml", e.target.value)}
            />
            <p className="hint">
              Ein Abmeldelink wird automatisch angehängt, wenn <code>{"{{unsubscribeUrl}}"}</code>{" "}
              fehlt.
            </p>
          </div>

          <details>
            <summary className="text-sm text-brand-700 cursor-pointer hover:underline">
              Text-Variante (optional)
            </summary>
            <div className="mt-3">
              <textarea
                name="bodyText"
                rows={6}
                className="input"
                value={values.bodyText}
                onChange={(e) => set("bodyText", e.target.value)}
                placeholder="Leer lassen — dann wird der Text automatisch aus dem HTML erzeugt."
              />
            </div>
          </details>
        </div>

        {/* Empfänger */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold">Empfänger</h2>

          <div>
            <label className="label" htmlFor="listId">
              Kontaktliste
            </label>
            <select
              id="listId"
              name="listId"
              className="input"
              value={values.listId}
              onChange={(e) => set("listId", e.target.value)}
            >
              <option value="">Alle aktiven Kontakte ({totalActiveContacts})</option>
              {lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.count})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label" htmlFor="tagFilter">
              Tag-Filter (optional)
            </label>
            <input
              id="tagFilter"
              name="tagFilter"
              className="input"
              value={values.tagFilter}
              onChange={(e) => set("tagFilter", e.target.value)}
              placeholder="kunde, messe2026"
            />
            <p className="hint">
              Kommagetrennt. Ein Kontakt wird angeschrieben, wenn er mindestens einen dieser Tags
              hat. Leer = kein Filter.
            </p>
          </div>

          <p className="text-xs text-slate-500">
            Geschätzt <strong>{recipientEstimate}</strong> Kontakte vor Filter. Abgemeldete und
            gesperrte Adressen werden immer ausgeschlossen.
          </p>
        </div>

        {/* Absender */}
        <div className="card p-5 space-y-3">
          <div className="flex items-baseline justify-between">
            <h2 className="font-semibold">Absender-Rotation</h2>
            <span className="text-xs text-slate-500">
              {values.senderIds.length === 0 ? "alle aktiven" : `${values.senderIds.length} gewählt`}
            </span>
          </div>

          {senders.length === 0 ? (
            <p className="toast-warn">
              Kein Absender vorhanden. Bitte zuerst unter „Absender“ ein Postfach anlegen.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                {senders.map((snd) => (
                  <label
                    key={snd.id}
                    className="flex items-center gap-3 rounded-xl px-3 py-2.5 bg-white/60 border border-slate-900/[0.08] cursor-pointer hover:bg-white/90 transition"
                  >
                    <input
                      type="checkbox"
                      name="senderIds"
                      value={snd.id}
                      checked={values.senderIds.includes(snd.id)}
                      onChange={() => toggleSender(snd.id)}
                      className="accent-brand-500 h-4 w-4"
                    />
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm truncate">{snd.email}</span>
                      <span className="block text-[11px] text-slate-500">
                        heute noch {snd.remaining} von {snd.limit}
                        {!snd.active && " · inaktiv"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="hint">
                Keine Auswahl = alle aktiven Absender. Mehrere Postfächer verteilen das Volumen und
                halten jedes einzelne unter seinem Tageslimit.
              </p>
            </>
          )}
        </div>
      </div>

      {/* --------------------------------------------------- rechte Spalte */}
      <div className="lg:col-span-2 space-y-4 sm:space-y-6 lg:sticky lg:top-20">
        {/* Taktung */}
        <div className="card p-5 space-y-5">
          <h2 className="font-semibold">Taktung</h2>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="label mb-0" htmlFor="intervalMinutes">
                Abstand
              </label>
              <span className="text-sm font-semibold mono text-brand-700">
                {values.intervalMinutes} min
              </span>
            </div>
            <input
              id="intervalMinutes"
              type="range"
              min={1}
              max={60}
              step={1}
              value={values.intervalMinutes}
              onChange={(e) => set("intervalMinutes", Number(e.target.value))}
              className="w-full accent-brand-500"
            />
            <input type="hidden" name="intervalMinutes" value={values.intervalMinutes} />
            <p className="hint">Basisabstand zwischen zwei Mails.</p>
          </div>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="label mb-0" htmlFor="jitterPercent">
                Zufalls-Streuung
              </label>
              <span className="text-sm font-semibold mono text-brand-700">
                ±{values.jitterPercent} %
              </span>
            </div>
            <input
              id="jitterPercent"
              type="range"
              min={0}
              max={100}
              step={5}
              value={values.jitterPercent}
              onChange={(e) => set("jitterPercent", Number(e.target.value))}
              className="w-full accent-brand-500"
            />
            <input type="hidden" name="jitterPercent" value={values.jitterPercent} />
            <p className="hint">
              {values.jitterPercent === 0
                ? "Ohne Streuung ist der Takt exakt gleichmäßig — das ist als Automat erkennbar."
                : `Ergibt Abstände von etwa ${round1(
                    (values.intervalMinutes * (100 - values.jitterPercent)) / 100
                  )} bis ${round1(
                    (values.intervalMinutes * (100 + values.jitterPercent)) / 100
                  )} Minuten.`}
            </p>
          </div>

          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              name="shuffleRecipients"
              value="1"
              checked={values.shuffleRecipients}
              onChange={(e) => set("shuffleRecipients", e.target.checked)}
              className="accent-brand-500 h-4 w-4 mt-0.5"
            />
            <span className="text-sm">
              Empfänger-Reihenfolge mischen
              <span className="block text-xs text-slate-500">
                Sonst wird alphabetisch bzw. in Importreihenfolge gesendet.
              </span>
            </span>
          </label>
        </div>

        {/* Sendefenster */}
        <div className="card p-5 space-y-4">
          <h2 className="font-semibold">Sendefenster</h2>

          <div>
            <span className="label">Wochentage</span>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <label key={d} className="daychip">
                  <input
                    type="checkbox"
                    name="sendDays"
                    value={d}
                    checked={values.sendDays.includes(d)}
                    onChange={() => toggleDay(d)}
                  />
                  <span>{DAY_LABELS[d]}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="windowStart">
                von
              </label>
              <input
                id="windowStart"
                name="windowStart"
                type="time"
                className="input"
                value={values.windowStart}
                onChange={(e) => set("windowStart", e.target.value)}
              />
            </div>
            <div>
              <label className="label" htmlFor="windowEnd">
                bis
              </label>
              <input
                id="windowEnd"
                name="windowEnd"
                type="time"
                className="input"
                value={values.windowEnd}
                onChange={(e) => set("windowEnd", e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="timezone">
              Zeitzone
            </label>
            <input
              id="timezone"
              name="timezone"
              className="input"
              value={values.timezone}
              onChange={(e) => set("timezone", e.target.value)}
              placeholder="Europe/Berlin"
            />
          </div>

          <p className="hint">
            Mails außerhalb des Fensters werden nicht gesendet, sondern auf die nächste Öffnung
            verschoben — der Takt läuft dann am Folgetag weiter.
          </p>
        </div>

        {/* Live-Vorschau */}
        <div className="card p-5">
          <div className="flex items-baseline justify-between mb-4">
            <h2 className="font-semibold">Vorschau</h2>
            {loading && <span className="text-xs text-slate-400">berechnet…</span>}
          </div>

          {preview?.error ? (
            <div className="toast-error">{preview.error}</div>
          ) : preview ? (
            <>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <Metric label="Empfänger" value={String(preview.recipientCount)} />
                <Metric label="Dauer" value={`${preview.spanDays} Tag(e)`} />
                <Metric label="Ø Abstand" value={`${preview.avgGapMinutes} min`} />
                <Metric
                  label="Spanne"
                  value={`${preview.minGapMinutes}–${preview.maxGapMinutes} min`}
                />
              </div>

              {preview.warning && <div className="toast-warn mb-4">{preview.warning}</div>}

              {preview.slots.length > 0 && (
                <>
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">
                    Erste Sendungen
                  </div>
                  <div className="timeline">
                    {preview.slots.map((slot, i) => (
                      <div key={slot.sequence} className="timeline-item is-muted">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="mono text-sm">{formatLocal(slot.scheduledAt)}</span>
                          <span className="badge bg-slate-100 text-slate-500 mono shrink-0">
                            {i === 0 ? "Start" : `+${round1(slot.gapSeconds / 60)} min`}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                  {preview.recipientCount > preview.slots.length && (
                    <p className="text-xs text-slate-400 mt-2">
                      … und {preview.recipientCount - preview.slots.length} weitere bis{" "}
                      {preview.last ? formatLocal(preview.last) : "—"}
                    </p>
                  )}
                </>
              )}
            </>
          ) : (
            <p className="text-sm text-slate-500">Wird berechnet, sobald Empfänger feststehen.</p>
          )}
        </div>

        <div className="action-bar">
          <button type="submit" name="intent" value="save" className="btn-secondary">
            Als Entwurf speichern
          </button>
          <button type="submit" name="intent" value="launch" className="btn-primary">
            {submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-white/60 border border-slate-900/[0.06] px-3 py-2.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="text-sm font-semibold mono mt-0.5">{value}</div>
    </div>
  );
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function formatLocal(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const DEFAULT_BODY = `<p>{Hallo|Guten Tag} {{firstName}},</p>

<p>kurz zu meinem Anliegen: …</p>

<p>{Beste Grüße|Viele Grüße|Freundliche Grüße}<br />
Ihr Team</p>`;
