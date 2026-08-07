"use client";

import { useCallback, useEffect, useState } from "react";

// Vorschau des Mailinhalts, wie der Empfänger ihn sieht.
//
// Gerendert in einem iframe mit sandbox="" - dadurch laufen im Vorschauinhalt
// keine Skripte und er kann nicht auf die umgebende Seite zugreifen. Bei
// HTML, das aus einem Baukasten kopiert wurde, ist das kein Luxus.
//
// Bewusst ohne Absenderzeile: die Vorschau soll auch funktionieren, wenn noch
// kein Postfach eingerichtet ist.

export interface PreviewContact {
  id: string;
  label: string;
}

interface PreviewResult {
  subject: string;
  html: string;
  text: string;
  usedContact: { id: string; label: string } | null;
  unresolved: string[];
  error?: string;
}

export function MailPreview({
  subject,
  bodyHtml,
  bodyText,
  contacts,
}: {
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  /** Auswahl echter Empfänger; leer = nur Beispieldaten. */
  contacts?: PreviewContact[];
}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"html" | "text">("html");
  const [contactId, setContactId] = useState<string>("");
  const [variant, setVariant] = useState(0);
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/campaigns/preview-html", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject,
          bodyHtml,
          bodyText: bodyText || undefined,
          contactId: contactId || null,
          variant,
        }),
      });
      setResult((await res.json()) as PreviewResult);
    } catch (e) {
      setResult({
        subject: "",
        html: "",
        text: "",
        usedContact: null,
        unresolved: [],
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setLoading(false);
    }
  }, [subject, bodyHtml, bodyText, contactId, variant]);

  // Nur laden, wenn die Vorschau offen ist - sonst würde jeder Tastendruck im
  // Editor eine Anfrage auslösen.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(load, 400);
    return () => clearTimeout(t);
  }, [open, load]);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold">Vorschau</h2>
          <p className="hint">So sieht die Mail beim Empfänger aus.</p>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className="btn-secondary">
          {open ? "Vorschau ausblenden" : "Vorschau anzeigen"}
        </button>
      </div>

      {open && (
        <div className="mt-4 space-y-3">
          {/* Steuerung */}
          <div className="flex flex-wrap items-end gap-3">
            {contacts && contacts.length > 0 && (
              <div className="min-w-[200px]">
                <label className="label" htmlFor="preview-contact">
                  Mit Daten von
                </label>
                <select
                  id="preview-contact"
                  className="input"
                  value={contactId}
                  onChange={(e) => setContactId(e.target.value)}
                >
                  <option value="">Beispieldaten (Max Mustermann)</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="segmented">
              <label>
                <input
                  type="radio"
                  name="preview-mode"
                  checked={mode === "html"}
                  onChange={() => setMode("html")}
                />
                <span>HTML</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="preview-mode"
                  checked={mode === "text"}
                  onChange={() => setMode("text")}
                />
                <span>Nur Text</span>
              </label>
            </div>

            <button
              type="button"
              onClick={() => setVariant((v) => (v + 1) % 100)}
              className="btn-secondary"
              title="Spintax wählt pro Empfänger eine Variante — hier durchblättern"
            >
              Andere Variante
            </button>

            {loading && <span className="text-xs text-slate-400 pb-2">lädt…</span>}
          </div>

          {result?.error && <div className="toast-error">{result.error}</div>}

          {result && !result.error && (
            <>
              {result.unresolved.length > 0 && (
                <div className="toast-warn">
                  <span>
                    Ohne Wert und damit leer beim Empfänger:{" "}
                    <strong>{result.unresolved.map((p) => `{{${p}}}`).join(", ")}</strong>
                    {contactId
                      ? " — bei diesem Kontakt ist das Feld nicht gefüllt."
                      : " — Feldname prüfen, oder die Kontakte haben dieses Feld nicht."}
                  </span>
                </div>
              )}

              {/* Betreff */}
              <div className="rounded-xl bg-white/70 border border-slate-900/[0.08] px-4 py-3">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Betreff
                </div>
                <div className="text-sm font-medium mt-0.5 break-words">
                  {result.subject || <span className="text-slate-400">(leer)</span>}
                </div>
                {result.usedContact && (
                  <div className="text-[11px] text-slate-500 mt-1.5">
                    Daten von {result.usedContact.label}
                  </div>
                )}
              </div>

              {/* Inhalt */}
              {mode === "html" ? (
                <div className="rounded-xl overflow-hidden border border-slate-900/[0.08] bg-white">
                  <iframe
                    title="Mailvorschau"
                    // sandbox="" = keine Skripte, kein Zugriff auf die App.
                    sandbox=""
                    srcDoc={result.html}
                    className="w-full block"
                    style={{ height: 460, border: 0 }}
                  />
                </div>
              ) : (
                <pre className="rounded-xl border border-slate-900/[0.08] bg-white px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap break-words max-h-[460px] overflow-auto">
                  {result.text}
                </pre>
              )}

              <p className="hint">
                Der Abmeldelink ist enthalten — er wird automatisch angehängt, wenn im Text kein{" "}
                <code>{"{{unsubscribeUrl}}"}</code> steht. Die „Nur Text“-Ansicht zeigt, was
                Empfänger ohne HTML-Darstellung sehen.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
