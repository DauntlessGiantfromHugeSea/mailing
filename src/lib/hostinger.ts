import { prisma } from "./db";
import { safeDecrypt } from "./crypto";

// ---------------------------------------------------------------------------
// Client fuer die Hostinger-API (https://developers.hostinger.com)
//
// WICHTIG - was die API kann und was nicht:
//
// Die oeffentliche Hostinger-API hat KEINEN Endpunkt zum Versenden einer
// E-Mail. Geprueft gegen die OpenAPI-Spec (v1.30.0): unter /api/mail/v1/ gibt
// es Postfach-Verwaltung, Plaene/Quotas, Zustell-Logs und Webhooks, unter
// /api/reach/v1/ Kontakte, Segmente, Tags und den DNS-Status der Domain.
// Ein "send message" existiert dort nicht.
//
// Der eigentliche Versand laeuft deshalb ueber SMTP (smtp.hostinger.com) mit
// den Zugangsdaten des jeweiligen Postfachs - siehe src/lib/mailer.ts. Die API
// uebernimmt hier alles drumherum:
//
//   listMailOrders()        -> welche Mail-Produkte gibt es im Konto
//   listMailboxes()         -> Postfaecher automatisch als Absender importieren
//   getOrderPlan()          -> Quotas/Limits -> sinnvolle Tageslimits ableiten
//   listOutboundLogs()      -> Abgleich: hat Hostinger die Mail wirklich zugestellt
//   listReachProfiles() +
//     getReachDnsStatus()   -> SPF/DKIM/DMARC-Preflight vor dem Kampagnenstart
//   listReachContacts()     -> Kontakte aus Hostinger Reach uebernehmen
//   createReachContactsBulk -> Kontakte nach Hostinger Reach zurueckschreiben
//
// Authentifizierung: Bearer-Token aus dem hPanel.
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://developers.hostinger.com";

export const HOSTINGER_TOKEN_SETTING = "hostinger.apiToken";

export class HostingerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown
  ) {
    super(message);
    this.name = "HostingerError";
  }
}

/** Liest das API-Token: Setting-Tabelle hat Vorrang, dann Environment. */
export async function getApiToken(): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: HOSTINGER_TOKEN_SETTING } });
  if (row?.value) {
    const token = row.encrypted ? safeDecrypt(row.value) : row.value;
    if (token) return token;
  }
  return process.env.HOSTINGER_API_TOKEN?.trim() || null;
}

export interface Paginated<T> {
  data: T[];
  meta?: { current_page?: number; last_page?: number; per_page?: number; total?: number };
}

export interface MailOrder {
  id: string;
  domain: string;
  status: "pending_setup" | "active" | "suspended" | string;
  plan?: string;
  is_trial?: boolean;
  expires_at?: string;
  created_at?: string;
}

export interface Mailbox {
  id: string;
  email: string;
  quota_used?: number;
  quota_limit?: number;
  status?: string;
  created_at?: string;
}

export interface OrderPlan {
  name?: string;
  mailbox_count?: number;
  storage_per_mailbox?: number;
  // Hostinger nennt das Tageslimit je nach Plan unterschiedlich; wir lesen
  // mehrere plausible Felder und nehmen den ersten Treffer.
  daily_sending_limit?: number;
  sending_limit_per_day?: number;
  outgoing_mails_per_day?: number;
  protocols?: string[];
  [key: string]: unknown;
}

export interface OutboundLogEntry {
  timestamp?: string;
  date?: string;
  sender?: string;
  from?: string;
  recipient?: string;
  to?: string;
  subject?: string;
  status?: "Successful" | "Failed" | string;
  message_id?: string;
  messageId?: string;
  [key: string]: unknown;
}

export interface ReachProfile {
  uuid: string;
  name?: string;
  domain?: string;
  [key: string]: unknown;
}

export interface ReachDnsStatus {
  // Feldnamen variieren; wir behandeln das Objekt tolerant.
  [key: string]: unknown;
}

export interface ReachContact {
  uuid?: string;
  email: string;
  first_name?: string;
  last_name?: string;
  [key: string]: unknown;
}

export class HostingerClient {
  private readonly baseUrl: string;

  constructor(
    private readonly token: string,
    baseUrl = process.env.HOSTINGER_API_BASE_URL || DEFAULT_BASE_URL
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {}
  ): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      cache: "no-store",
    });

    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const message =
        (parsed && typeof parsed === "object" && "message" in parsed
          ? String((parsed as { message: unknown }).message)
          : null) ?? `Hostinger-API ${res.status} ${res.statusText}`;
      throw new HostingerError(message, res.status, parsed);
    }
    return parsed as T;
  }

  /** Billigster Call, der ein gueltiges Token beweist. */
  async ping(): Promise<{ ok: true; orders: number }> {
    const r = await this.listMailOrders({ per_page: 1 });
    return { ok: true, orders: r.meta?.total ?? r.data.length };
  }

  // --------------------------------------------------------------- Mail API

  listMailOrders(query: { domain?: string; status?: string; page?: number; per_page?: number } = {}) {
    return this.request<Paginated<MailOrder>>("GET", "/api/mail/v1/orders", { query });
  }

  listMailboxes(orderId: string, query: { page?: number; per_page?: number } = {}) {
    return this.request<Paginated<Mailbox>>(
      "GET",
      `/api/mail/v1/orders/${encodeURIComponent(orderId)}/mailboxes`,
      { query }
    );
  }

  getOrderPlan(orderId: string) {
    return this.request<OrderPlan | { data: OrderPlan }>(
      "GET",
      `/api/mail/v1/orders/${encodeURIComponent(orderId)}/plan`
    );
  }

  /**
   * Outbound-Zustell-Log. Das ist unsere unabhaengige Kontrolle: SMTP sagt nur
   * "angenommen", dieses Log sagt, was Hostinger daraus gemacht hat.
   */
  listOutboundLogs(
    orderId: string,
    query: {
      account?: string;
      date?: string;
      from_date?: string;
      to_date?: string;
      status?: "Successful" | "Failed";
      sender?: string;
      recipient?: string;
      page?: number;
      per_page?: number;
    } = {}
  ) {
    return this.request<Paginated<OutboundLogEntry>>(
      "GET",
      `/api/mail/v1/orders/${encodeURIComponent(orderId)}/logs/outbound`,
      { query }
    );
  }

  // -------------------------------------------------------------- Reach API

  listReachProfiles(query: { page?: number; per_page?: number } = {}) {
    return this.request<Paginated<ReachProfile>>("GET", "/api/reach/v1/profiles", { query });
  }

  /** SPF/DKIM/DMARC-Status der Absenderdomain eines Reach-Profils. */
  getReachDnsStatus(profileUuid: string) {
    return this.request<ReachDnsStatus>(
      "GET",
      `/api/reach/v1/profiles/${encodeURIComponent(profileUuid)}/domains/dns-status`
    );
  }

  listReachContacts(profileUuid: string, query: { page?: number; per_page?: number } = {}) {
    return this.request<Paginated<ReachContact>>(
      "GET",
      `/api/reach/v1/profiles/${encodeURIComponent(profileUuid)}/contacts`,
      { query }
    );
  }

  createReachContactsBulk(profileUuid: string, contacts: ReachContact[]) {
    return this.request<unknown>(
      "POST",
      `/api/reach/v1/profiles/${encodeURIComponent(profileUuid)}/contacts/bulk`,
      { body: { contacts } }
    );
  }
}

/** Client aus der gespeicherten Konfiguration. null = kein Token hinterlegt. */
export async function getHostingerClient(): Promise<HostingerClient | null> {
  const token = await getApiToken();
  return token ? new HostingerClient(token) : null;
}

// --------------------------------------------------------------- Hilfsfunktionen

/** Holt alle Seiten einer paginierten Liste (mit Sicherheitsdeckel). */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<Paginated<T>>,
  maxPages = 50
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchPage(page);
    const items = res?.data ?? [];
    out.push(...items);
    const last = res?.meta?.last_page;
    if (last !== undefined ? page >= last : items.length === 0) break;
    if (last === undefined && items.length === 0) break;
  }
  return out;
}

/**
 * Liest aus dem Plan-Objekt ein Tages-Sendelimit heraus. Hostinger benennt das
 * Feld je nach Plan unterschiedlich, daher mehrere Kandidaten.
 */
export function dailyLimitFromPlan(plan: OrderPlan | { data: OrderPlan }): number | null {
  const p = ("data" in plan && plan.data ? plan.data : plan) as OrderPlan;
  const candidates = [
    p.daily_sending_limit,
    p.sending_limit_per_day,
    p.outgoing_mails_per_day,
    (p as Record<string, unknown>)["daily_limit"],
    (p as Record<string, unknown>)["emails_per_day"],
  ];
  for (const c of candidates) {
    const n = typeof c === "string" ? Number(c) : c;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

export interface DnsCheckItem {
  name: string;
  ok: boolean | null;
  detail?: string;
}

/**
 * Normalisiert die DNS-Status-Antwort in eine Liste anzeigbarer Checks.
 * Die Antwortform ist nicht streng dokumentiert, deshalb wird das Objekt
 * rekursiv nach SPF/DKIM/DMARC-artigen Schluesseln durchsucht.
 */
export function normalizeDnsStatus(raw: unknown): DnsCheckItem[] {
  const wanted = ["spf", "dkim", "dmarc", "mx"];
  const found = new Map<string, DnsCheckItem>();

  const truthy = (v: unknown): boolean | null => {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const s = v.toLowerCase();
      if (["valid", "ok", "active", "verified", "true", "pass", "configured"].includes(s)) return true;
      if (["invalid", "missing", "failed", "false", "fail", "not_found", "pending"].includes(s)) return false;
    }
    return null;
  };

  const walk = (node: unknown, path: string[]) => {
    if (node === null || node === undefined) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, [...path, String(i)]));
      return;
    }
    if (typeof node === "object") {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        const lower = k.toLowerCase();
        const hit = wanted.find((w) => lower.includes(w));
        if (hit && !found.has(hit)) {
          let ok: boolean | null = null;
          let detail: string | undefined;
          if (typeof v === "object" && v !== null && !Array.isArray(v)) {
            const obj = v as Record<string, unknown>;
            for (const cand of ["status", "valid", "is_valid", "verified", "state", "result"]) {
              const t = truthy(obj[cand]);
              if (t !== null) {
                ok = t;
                break;
              }
            }
            const d = obj["value"] ?? obj["expected"] ?? obj["message"] ?? obj["record"];
            if (typeof d === "string") detail = d;
          } else {
            ok = truthy(v);
            if (typeof v === "string") detail = v;
          }
          found.set(hit, { name: hit.toUpperCase(), ok, detail });
        }
        walk(v, [...path, k]);
      }
    }
  };

  walk(raw, []);
  return wanted.filter((w) => found.has(w)).map((w) => found.get(w)!);
}
