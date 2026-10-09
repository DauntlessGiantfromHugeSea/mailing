import { NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { makeRng } from "@/lib/random";
import {
  contactVars,
  ensureUnsubscribeFooter,
  renderHtml,
  render,
  unsubscribeUrl,
  usedPlaceholders,
  appUrl,
} from "@/lib/templates";
import { htmlToText } from "@/lib/mailer";

// Rendert Betreff und HTML so, wie ein Empfänger sie bekommt: Platzhalter
// gefüllt, Spintax aufgelöst, Abmeldefuß angehängt.
//
// Bewusst ohne Absenderbezug - die Vorschau soll auch funktionieren, wenn noch
// kein Postfach eingerichtet ist. Sie zeigt den Mailinhalt, nicht den Umschlag.

const Body = z.object({
  subject: z.string().max(1_000).default(""),
  bodyHtml: z.string().max(200_000).default(""),
  bodyText: z.string().max(200_000).optional(),
  /** Echten Kontakt nehmen; leer = Beispieldaten. */
  contactId: z.string().optional().nullable(),
  /** Wechselt die Spintax-Variante, ohne den Text zu ändern. */
  variant: z.number().int().min(0).max(99).optional().default(0),
});

/** Beispielempfänger, wenn noch keine Kontakte da sind. */
const SAMPLE: Record<string, string> = {
  email: "max.mustermann@example.org",
  firstName: "Max",
  lastName: "Mustermann",
  fullName: "Max Mustermann",
  company: "Beispiel GmbH",
  unsubscribeUrl: `${appUrl()}/abmelden?token=BEISPIEL-TOKEN`,
};

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return jsonError("Nicht angemeldet", 401);
  // Vorschau mit echten Kontaktdaten nur für Rollen, die Kampagnen bearbeiten
  // dürfen (Sicherheits-Audit 2026-10: VIEWER konnte Abmelde-Tokens auslesen).
  if (!canEdit(session)) return jsonError("Keine Berechtigung", 403);

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return jsonError("Ungültige Eingabe", 422);
  const { subject, bodyHtml, bodyText, contactId, variant } = parsed.data;

  // Variablen bestimmen: echter Kontakt oder Beispieldaten.
  let vars: Record<string, string> = SAMPLE;
  let usedContact: { id: string; label: string } | null = null;

  if (contactId) {
    const contact = await prisma.contact.findUnique({ where: { id: contactId } });
    if (contact) {
      const v = contactVars(contact);
      // Nie den echten Abmeldelink des Kontakts in der Vorschau zeigen.
      vars = { ...v, unsubscribeUrl: SAMPLE.unsubscribeUrl };
      usedContact = {
        id: contact.id,
        label: [v.firstName, v.lastName].filter(Boolean).join(" ") || v.email || "Kontakt",
      };
    }
  }

  const unsub = vars.unsubscribeUrl ?? SAMPLE.unsubscribeUrl;

  // Eigener RNG je Variante, damit sich Spintax-Varianten durchblättern lassen.
  const renderedSubject = render(subject, vars, makeRng(`preview:${variant}:subject`));
  const renderedHtml = ensureUnsubscribeFooter(
    renderHtml(bodyHtml, vars, makeRng(`preview:${variant}:body`)),
    unsub
  );
  const renderedText = bodyText
    ? render(bodyText, vars, makeRng(`preview:${variant}:text`))
    : htmlToText(renderedHtml);

  // Platzhalter benennen, die im Text stehen, aber keinen Wert haben - sonst
  // fällt erst dem Empfänger die Lücke auf ("Hallo ,").
  const known = new Set([...Object.keys(vars), "unsubscribe", "vorname", "nachname", "firma"]);
  const unresolved = [...usedPlaceholders(subject), ...usedPlaceholders(bodyHtml)]
    .filter((p) => !known.has(p) || !vars[p])
    .filter((p, i, a) => a.indexOf(p) === i)
    .filter((p) => !["unsubscribe", "unsubscribeUrl"].includes(p));

  return NextResponse.json({
    subject: renderedSubject,
    html: wrapForPreview(renderedHtml),
    text: renderedText,
    usedContact,
    unresolved,
  });
}

/**
 * Umschliesst den Mailinhalt mit einem neutralen Grundgerüst, damit die
 * Vorschau im iframe wie in einem Mailprogramm aussieht und nicht die
 * Schriftarten der App erbt.
 */
function wrapForPreview(inner: string): string {
  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  html,body{margin:0;padding:0;background:#fff}
  body{font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
       font-size:15px;line-height:1.6;color:#1f2937;padding:18px}
  a{color:#004c4d}
  img{max-width:100%;height:auto}
  table{border-collapse:collapse;max-width:100%}
  pre{white-space:pre-wrap;word-break:break-word}
</style></head>
<body>${inner}</body></html>`;
}
