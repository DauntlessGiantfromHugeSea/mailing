import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { Sender } from "@prisma/client";
import { safeDecrypt } from "./crypto";
import { assertSmtpTarget } from "./smtpTarget";

// Der eigentliche Versand. Ein Transport pro Absender-Postfach, gecached ueber
// die Prozesslaufzeit.
//
// Bewusst KEIN Pool und KEIN internes Rate-Limit von nodemailer: die Taktung
// macht der Scheduler ueber `scheduledAt` je Job. Ein Pool wuerde Verbindungen
// offen halten und mehrere Mails buendeln - genau das, was hier vermieden
// werden soll. Jede Mail ist eine eigene Verbindung, wie bei einem Menschen,
// der eine Mail schreibt und abschickt.

export interface SendInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
  listUnsubscribeUrl?: string;
  /** Optionaler In-Reply-To/References-Header fuer Follow-ups. */
  headers?: Record<string, string>;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  /** true = SMTP hat vorruebergehend abgelehnt, erneuter Versuch sinnvoll */
  retryable?: boolean;
}

const transports = new Map<string, { key: string; transporter: Transporter }>();

function senderConfigKey(s: Sender): string {
  return [s.smtpHost, s.smtpPort, s.smtpSecure, s.smtpUser, s.smtpPassEnc].join("|");
}

function transportFor(sender: Sender): Transporter {
  const key = senderConfigKey(sender);
  const cached = transports.get(sender.id);
  if (cached && cached.key === key) return cached.transporter;

  const pass = safeDecrypt(sender.smtpPassEnc);
  if (!pass) {
    throw new Error(
      `SMTP-Passwort von "${sender.label}" konnte nicht entschluesselt werden (falscher FIELD_ENCRYPTION_KEY?)`
    );
  }

  const options: SMTPTransport.Options = {
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    auth: { user: sender.smtpUser, pass },
    connectionTimeout: 20_000,
    greetingTimeout: 12_000,
    socketTimeout: 40_000,
  };
  const transporter = nodemailer.createTransport(options);

  transports.set(sender.id, { key, transporter });
  return transporter;
}

/** Cache invalidieren, z.B. nach dem Bearbeiten eines Absenders. */
export function forgetTransport(senderId: string): void {
  transports.get(senderId)?.transporter.close();
  transports.delete(senderId);
}

const RETRYABLE_CODES = new Set([
  "ETIMEDOUT",
  "ECONNECTION",
  "ECONNRESET",
  "ESOCKET",
  "EDNS",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; responseCode?: number };
  if (e.code && RETRYABLE_CODES.has(e.code)) return true;
  // 4xx = temporaer (z.B. "too many messages"), 5xx = endgueltig
  if (typeof e.responseCode === "number" && e.responseCode >= 400 && e.responseCode < 500) return true;
  return false;
}

export function formatFrom(sender: Sender): string {
  const name = sender.fromName?.trim();
  return name ? `${JSON.stringify(name)} <${sender.email}>` : sender.email;
}

/** Versendet eine einzelne Mail ueber einen bestimmten Absender. */
export async function sendViaSender(sender: Sender, input: SendInput): Promise<SendResult> {
  let transporter: Transporter;
  try {
    await assertSmtpTarget(sender.smtpHost, sender.smtpPort);
    transporter = transportFor(sender);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: false };
  }

  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if (input.listUnsubscribeUrl) {
    headers["List-Unsubscribe"] = `<${input.listUnsubscribeUrl}>`;
    headers["List-Unsubscribe-Post"] = "List-Unsubscribe=One-Click";
  }

  try {
    const info = await transporter.sendMail({
      from: formatFrom(sender),
      to: input.to,
      replyTo: sender.replyTo || undefined,
      subject: input.subject,
      html: input.html,
      text: input.text ?? htmlToText(input.html),
      headers,
    });
    return { ok: true, messageId: info.messageId };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? `${(e as { code?: string }).code ?? ""} ${e.message}`.trim() : String(e),
      retryable: isRetryable(e),
    };
  }
}

/** Verbindungs- und Auth-Test ohne Mailversand. */
export async function verifySender(sender: Sender): Promise<{ ok: boolean; error?: string }> {
  try {
    await assertSmtpTarget(sender.smtpHost, sender.smtpPort);
    await transportFor(sender).verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: kurzerFehler(e) };
  }
}

/** Fehlermeldung ohne Antworttext des Gegenübers (kein Banner-Leak). */
function kurzerFehler(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.replace(/\s*response=[\s\S]*$/i, "").slice(0, 200);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
