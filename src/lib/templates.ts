import { safeDecrypt } from "./crypto";
import type { Contact } from "@prisma/client";

// Platzhalter-Ersetzung im Mailtext: {{firstName}}, {{company}}, {{unsubscribe}} ...
//
// Zusaetzlich Spintax: {Hallo|Guten Tag|Hi} waehlt pro Empfaenger eine Variante.
// Das ist der zweite Baustein gegen Muster-Erkennung: nicht nur die Sendezeiten
// variieren, sondern auch der Text. Die Auswahl ist pro Empfaenger stabil
// (deterministisch aus dem Seed), damit ein erneuter Versuch dieselbe Mail
// erzeugt.

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function unsubscribeUrl(token: string): string {
  return `${appUrl()}/abmelden?token=${encodeURIComponent(token)}`;
}

export interface ContactVars {
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  company: string;
  unsubscribeUrl: string;
  [key: string]: string;
}

export function contactVars(contact: Contact): ContactVars {
  const first = safeDecrypt(contact.firstName) ?? "";
  const last = safeDecrypt(contact.lastName) ?? "";
  const custom: Record<string, string> = {};
  if (contact.customFields) {
    try {
      const parsed = JSON.parse(contact.customFields);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v !== null && v !== undefined) custom[k] = String(v);
        }
      }
    } catch {
      /* kaputtes JSON ignorieren */
    }
  }

  return {
    ...custom,
    email: safeDecrypt(contact.email) ?? "",
    firstName: first,
    lastName: last,
    fullName: [first, last].filter(Boolean).join(" "),
    company: safeDecrypt(contact.company) ?? "",
    unsubscribeUrl: unsubscribeUrl(contact.unsubscribeToken),
  };
}

/**
 * Spintax aufloesen: {a|b|c} -> eine Variante. Verschachtelung wird von innen
 * nach aussen aufgeloest.
 */
export function resolveSpintax(text: string, rng: () => number): string {
  let out = text;
  const pattern = /\{([^{}]*\|[^{}]*)\}/;
  for (let guard = 0; guard < 500; guard++) {
    const m = pattern.exec(out);
    if (!m) break;
    const options = m[1].split("|");
    const choice = options[Math.floor(rng() * options.length)] ?? options[0];
    out = out.slice(0, m.index) + choice + out.slice(m.index + m[0].length);
  }
  return out;
}

/** HTML-Sonderzeichen maskieren (fuer Werte, die in HTML eingesetzt werden). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Ersetzt {{key}} bzw. {{ key }} durch den Wert. Unbekannte Keys -> leer.
 * Mit mode "html" werden die Werte HTML-maskiert: Kontaktdaten stammen z. T.
 * aus fremden Quellen (Verteiler-Postfach, CSV, Reach) und duerfen nie als
 * Markup im Mailtext landen (Sicherheits-Audit 2026-10).
 */
export function fillPlaceholders(
  template: string,
  vars: Record<string, string>,
  mode: "text" | "html" = "text"
): string {
  const out = (v: string) => (mode === "html" ? escapeHtml(v) : v);
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_all, key: string) => {
    const direct = vars[key];
    if (direct !== undefined) return out(direct);
    // Aliase fuer Bequemlichkeit
    if (key === "unsubscribe") return out(vars.unsubscribeUrl ?? "");
    if (key === "vorname") return out(vars.firstName ?? "");
    if (key === "nachname") return out(vars.lastName ?? "");
    if (key === "firma") return out(vars.company ?? "");
    return "";
  });
}

export function render(template: string, vars: Record<string, string>, rng: () => number): string {
  return fillPlaceholders(resolveSpintax(template, rng), vars);
}

/** Wie render(), aber fuer HTML-Vorlagen: eingesetzte Werte werden maskiert. */
export function renderHtml(template: string, vars: Record<string, string>, rng: () => number): string {
  return fillPlaceholders(resolveSpintax(template, rng), vars, "html");
}

/**
 * Haengt einen Abmelde-Hinweis an, falls der Text keinen enthaelt. Ohne
 * funktionierenden Abmeldelink ist ein Massenversand in der EU nicht zulaessig.
 */
export function ensureUnsubscribeFooter(html: string, url: string): string {
  // Nur der echte Abmeldelink des Empfaengers zaehlt. Ein woertliches
  // "{{unsubscribe}}" kann aus Kontaktdaten stammen und darf den Footer nicht
  // unterdruecken (Sicherheits-Audit 2026-10).
  if (url && (html.includes(url) || html.includes(escapeHtml(url)))) return html;
  url = escapeHtml(url);
  return (
    html +
    `\n<hr style="border:0;border-top:1px solid #e2e8f0;margin:28px 0 12px" />` +
    `\n<p style="font-size:12px;color:#64748b;margin:0">` +
    `Sie möchten keine weiteren E-Mails erhalten? ` +
    `<a href="${url}" style="color:#004c4d">Hier abmelden</a>.</p>`
  );
}

/** Liste der im Text verwendeten Platzhalter - fuer die Validierung in der UI. */
export function usedPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const m of template.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) found.add(m[1]);
  return Array.from(found).sort();
}
