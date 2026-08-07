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

/** Ersetzt {{key}} bzw. {{ key }} durch den Wert. Unbekannte Keys -> leer. */
export function fillPlaceholders(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_all, key: string) => {
    const direct = vars[key];
    if (direct !== undefined) return direct;
    // Aliase fuer Bequemlichkeit
    if (key === "unsubscribe") return vars.unsubscribeUrl ?? "";
    if (key === "vorname") return vars.firstName ?? "";
    if (key === "nachname") return vars.lastName ?? "";
    if (key === "firma") return vars.company ?? "";
    return "";
  });
}

export function render(template: string, vars: Record<string, string>, rng: () => number): string {
  return fillPlaceholders(resolveSpintax(template, rng), vars);
}

/**
 * Haengt einen Abmelde-Hinweis an, falls der Text keinen enthaelt. Ohne
 * funktionierenden Abmeldelink ist ein Massenversand in der EU nicht zulaessig.
 */
export function ensureUnsubscribeFooter(html: string, url: string): string {
  if (html.includes(url) || /\{\{\s*unsubscribe(Url)?\s*\}\}/i.test(html)) return html;
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
