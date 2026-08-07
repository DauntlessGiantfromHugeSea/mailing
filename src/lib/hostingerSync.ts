import { prisma } from "./db";
import {
  dailyLimitFromPlan,
  fetchAllPages,
  getHostingerClient,
  extractReachProfiles,
  itemsOf,
  normalizeDnsStatus,
  type DnsCheckItem,
  type MailOrder,
  type ReachProfile,
} from "./hostinger";
import { encryptField, blindIndex } from "./crypto";
import { upsertContacts } from "./contacts";
import { getSetting, SETTINGS } from "./settings";

// Alles, was die Hostinger-API fuer den Versand beitraegt. Der Versand selbst
// laeuft ueber SMTP (die API hat keinen Send-Endpunkt) - aber Postfaecher,
// Limits, Deliverability und Zustellkontrolle kommen von hier.

export class SyncError extends Error {}

async function client() {
  const c = await getHostingerClient();
  if (!c) {
    throw new SyncError(
      "Kein Hostinger-API-Token hinterlegt. Bitte unter „Einstellungen“ eintragen."
    );
  }
  return c;
}

// ---------------------------------------------------- Postfaecher -> Absender

export interface DiscoveredMailbox {
  orderId: string;
  domain: string;
  mailboxId: string;
  email: string;
  /** Aus dem Plan abgeleitetes Tageslimit, falls die API eines liefert. */
  planDailyLimit: number | null;
  /** Existiert dieses Postfach bereits als Absender? */
  alreadyImported: boolean;
}

/**
 * Listet alle Postfaecher aller aktiven Mail-Bestellungen. Das ist die Basis
 * fuer den Absender-Import: statt SMTP-Daten von Hand einzutippen, sieht man
 * genau die Postfaecher, die im Konto existieren.
 */
export async function discoverMailboxes(): Promise<DiscoveredMailbox[]> {
  const c = await client();

  const orders = await fetchAllPages((page) => c.listMailOrders({ page, per_page: 50 }));
  const existing = new Set(
    (await prisma.sender.findMany({ select: { hostingerMailboxId: true } }))
      .map((s) => s.hostingerMailboxId)
      .filter((v): v is string => Boolean(v))
  );

  const out: DiscoveredMailbox[] = [];
  for (const order of orders) {
    if (order.status === "suspended") continue;

    let planDailyLimit: number | null = null;
    try {
      planDailyLimit = dailyLimitFromPlan(await c.getOrderPlan(order.id));
    } catch {
      // Plan-Endpunkt ist optional - ohne ihn bleibt der Default.
    }

    const mailboxes = await fetchAllPages((page) =>
      c.listMailboxes(order.id, { page, per_page: 100 })
    );
    for (const mb of mailboxes) {
      out.push({
        orderId: String(order.id),
        domain: order.domain,
        mailboxId: String(mb.id),
        email: mb.email,
        planDailyLimit,
        alreadyImported: existing.has(String(mb.id)),
      });
    }
  }
  return out;
}

export interface ImportMailboxInput {
  orderId: string;
  mailboxId: string;
  email: string;
  fromName: string;
  smtpPassword: string;
  dailyLimit?: number;
  smtpHost?: string;
  smtpPort?: number;
  replyTo?: string | null;
  warmupEnabled?: boolean;
}

/**
 * Uebernimmt ein per API entdecktes Postfach als Absender. Das SMTP-Passwort
 * kann die API nicht liefern (aus gutem Grund) - es muss einmal eingegeben
 * werden. Alles andere ist vorbefuellt.
 */
export async function importMailboxAsSender(input: ImportMailboxInput) {
  const existing = await prisma.sender.findFirst({
    where: { hostingerMailboxId: input.mailboxId },
  });

  const data = {
    label: input.email,
    fromName: input.fromName,
    email: input.email,
    replyTo: input.replyTo ?? null,
    smtpHost: input.smtpHost ?? "smtp.hostinger.com",
    smtpPort: input.smtpPort ?? 465,
    smtpSecure: (input.smtpPort ?? 465) === 465,
    smtpUser: input.email,
    smtpPassEnc: encryptField(input.smtpPassword)!,
    dailyLimit: input.dailyLimit ?? 40,
    warmupEnabled: input.warmupEnabled ?? true,
    hostingerOrderId: input.orderId,
    hostingerMailboxId: input.mailboxId,
  };

  if (existing) {
    return prisma.sender.update({ where: { id: existing.id }, data });
  }
  return prisma.sender.create({ data });
}

// ------------------------------------------------- Deliverability-Preflight

export interface DeliverabilityReport {
  profileUuid: string | null;
  profileName: string | null;
  checks: DnsCheckItem[];
  /** true = alle bekannten Checks bestanden. */
  allOk: boolean;
  warning?: string;
}

/**
 * SPF/DKIM/DMARC-Status der Absenderdomain. Vor einem Drip-Versand ist das der
 * wichtigste Check: ohne saubere Authentifizierung landen auch perfekt
 * getaktete Mails im Spam.
 */
export async function checkDeliverability(profileUuid?: string): Promise<DeliverabilityReport> {
  const c = await client();

  let uuid = profileUuid ?? (await getSetting(SETTINGS.reachProfileUuid)) ?? null;
  let profileName: string | null = null;

  if (!uuid) {
    const profiles = await c.listReachProfiles({ per_page: 50 });
    const first = extractReachProfiles(profiles)[0];
    if (!first) {
      return {
        profileUuid: null,
        profileName: null,
        checks: [],
        allOk: false,
        warning:
          "Kein Hostinger-Reach-Profil gefunden. Der DNS-Check (SPF/DKIM/DMARC) benötigt ein Reach-Profil im Hostinger-Konto.",
      };
    }
    uuid = first.uuid;
    profileName = first.name ?? first.domain ?? null;
  }

  const raw = await c.getReachDnsStatus(uuid);
  const checks = normalizeDnsStatus(raw);

  return {
    profileUuid: uuid,
    profileName,
    checks,
    allOk: checks.length > 0 && checks.every((c) => c.ok === true),
    warning:
      checks.length === 0
        ? "Die API hat keinen auswertbaren DNS-Status geliefert. Bitte SPF/DKIM/DMARC im hPanel prüfen."
        : undefined,
  };
}

// -------------------------------------------------------- Kontakte aus Reach

export async function importReachContacts(opts: {
  profileUuid?: string;
  listId?: string | null;
}): Promise<{ imported: number; created: number; updated: number; skipped: number }> {
  const c = await client();

  // Profil bestimmen: Vorgabe, gespeicherte Einstellung, sonst das erste
  // Profil des Kontos. Vorher wurde hier hart abgebrochen, wenn die UUID nicht
  // von Hand eingetragen war - obwohl der DNS-Check sie längst selbst findet.
  // Wer nur ein Reach-Profil hat, sollte nichts konfigurieren müssen.
  let uuid = opts.profileUuid ?? (await getSetting(SETTINGS.reachProfileUuid)) ?? null;
  if (!uuid) {
    const first = extractReachProfiles(await c.listReachProfiles({ per_page: 50 }))[0];
    if (!first) {
      throw new SyncError(
        "Im Hostinger-Konto ist kein Reach-Profil vorhanden. Kontakte können per CSV-Import oder „Kontakt hinzufügen“ gepflegt werden."
      );
    }
    uuid = first.uuid;
  }

  const contacts = await fetchAllPages((page) =>
    c.listReachContacts(uuid, { page, per_page: 100 })
  );

  const stats = await upsertContacts(
    contacts
      .filter((x) => typeof x.email === "string" && x.email.includes("@"))
      .map((x) => ({
        email: x.email,
        firstName: x.first_name ?? null,
        lastName: x.last_name ?? null,
        source: "hostinger-reach",
        reachContactUuid: x.uuid ?? null,
      })),
    { listId: opts.listId ?? null }
  );

  return {
    imported: stats.created + stats.updated,
    created: stats.created,
    updated: stats.updated,
    skipped: stats.suppressed + stats.invalid.length,
  };
}

// ------------------------------------------------------- Zustell-Abgleich

export interface ReconcileResult {
  checked: number;
  confirmed: number;
  failedAtProvider: number;
  unmatched: number;
  note?: string;
}

/**
 * Gleicht gesendete Jobs gegen das Hostinger-Outbound-Log ab.
 *
 * SMTP bestaetigt nur die Annahme durch den Server. Ob Hostinger die Mail dann
 * wirklich ausgeliefert hat, steht im Outbound-Log - inklusive "Failed" fuer
 * abgewiesene Empfaenger. Ohne diesen Abgleich sieht eine Kampagne zu gut aus.
 */
export async function reconcileDelivery(opts: {
  orderId?: string;
  hoursBack?: number;
}): Promise<ReconcileResult> {
  const c = await client();
  const orderId = opts.orderId ?? (await getSetting(SETTINGS.mailOrderId));
  if (!orderId) {
    // Kein Order gesetzt: den ersten aktiven nehmen.
    const orders = await c.listMailOrders({ status: "active", per_page: 1 });
    const first = itemsOf<MailOrder>(orders)[0];
    if (!first) throw new SyncError("Keine aktive Mail-Bestellung im Hostinger-Konto gefunden.");
    return reconcileDelivery({ orderId: String(first.id), hoursBack: opts.hoursBack });
  }

  const hoursBack = opts.hoursBack ?? 24;
  const since = new Date(Date.now() - hoursBack * 3_600_000);

  const jobs = await prisma.sendJob.findMany({
    where: { status: "SENT", sentAt: { gte: since }, providerStatus: null },
    include: { contact: true },
    take: 500,
  });
  if (jobs.length === 0) {
    return { checked: 0, confirmed: 0, failedAtProvider: 0, unmatched: 0, note: "Keine offenen Jobs zum Abgleich." };
  }

  const logs = await fetchAllPages(
    (page) =>
      c.listOutboundLogs(orderId, {
        from_date: since.toISOString(),
        to_date: new Date().toISOString(),
        page,
        per_page: 100,
      }),
    20
  );

  // Log-Eintraege nach Empfaenger-Blindindex gruppieren, jeweils der neueste
  // Status gewinnt.
  const byRecipient = new Map<string, string>();
  for (const entry of logs) {
    const recipient = (entry.recipient ?? entry.to) as string | undefined;
    const status = entry.status;
    if (!recipient || !status) continue;
    byRecipient.set(blindIndex(recipient), String(status));
  }

  let confirmed = 0;
  let failedAtProvider = 0;
  let unmatched = 0;
  const now = new Date();

  for (const job of jobs) {
    const status = byRecipient.get(job.contact.emailHash);
    if (!status) {
      unmatched++;
      continue;
    }
    const ok = status.toLowerCase() === "successful";
    await prisma.sendJob.update({
      where: { id: job.id },
      data: {
        providerStatus: status,
        providerCheckedAt: now,
        ...(ok ? {} : { status: "FAILED" as const, error: `Hostinger-Log: ${status}` }),
      },
    });
    if (ok) {
      confirmed++;
    } else {
      failedAtProvider++;
      await prisma.campaign.update({
        where: { id: job.campaignId },
        data: { sentCount: { decrement: 1 }, failedCount: { increment: 1 } },
      });
      // Wiederholte Zustellfehler -> Kontakt hart sperren.
      const bounces = await prisma.contact.update({
        where: { id: job.contactId },
        data: { bounceCount: { increment: 1 } },
      });
      if (bounces.bounceCount >= 2) {
        await prisma.contact.update({ where: { id: job.contactId }, data: { status: "BOUNCED" } });
        await prisma.suppression.upsert({
          where: { emailHash: bounces.emailHash },
          create: { emailHash: bounces.emailHash, reason: "bounce", note: `${bounces.bounceCount} Zustellfehler` },
          update: { note: `${bounces.bounceCount} Zustellfehler` },
        });
      }
    }
  }

  return { checked: jobs.length, confirmed, failedAtProvider, unmatched };
}

// ------------------------------------------------------------------ Diagnose

export interface EndpointProbe {
  path: string;
  status: number;
  ok: boolean;
  topLevelKeys: string[];
  itemCount: number;
  itemKeys: string[];
  message?: string;
}

export interface HostingerDiagnosis {
  tokenOk: boolean;
  tokenError?: string;
  mailOrders: { id: string; domain: string; status: string; mailboxes: number }[];
  reachProfiles: { uuid: string; name: string }[];
  /** Rohe Antworten je Endpunkt - zeigt Status und Struktur, keine Inhalte. */
  probes: EndpointProbe[];
  /** Klartext-Einordnung für die Oberfläche. */
  findings: { level: "ok" | "warn" | "info"; text: string }[];
}

/**
 * Zeigt, was die API im Konto tatsaechlich vorfindet.
 *
 * Grund: "Keine Postfaecher gefunden" ist als Rueckmeldung nutzlos - es kann
 * ein falsches Token, ein fehlendes Produkt oder eine leere Bestellung
 * bedeuten. Diese Funktion benennt den Unterschied.
 */
export async function diagnose(): Promise<HostingerDiagnosis> {
  const out: HostingerDiagnosis = {
    tokenOk: false,
    mailOrders: [],
    reachProfiles: [],
    probes: [],
    findings: [],
  };

  let c;
  try {
    c = await client();
  } catch (e) {
    out.tokenError = e instanceof Error ? e.message : String(e);
    out.findings.push({ level: "info", text: out.tokenError });
    return out;
  }

  // --- Rohe Antworten erheben. Das trennt "Token falsch" von "keine
  //     Berechtigung" von "200 mit leerer Liste" - von aussen nicht
  //     unterscheidbar, aber die Ursache ist jeweils eine andere.
  out.probes.push(await c.probe("/api/mail/v1/orders", { per_page: 5 }));
  out.probes.push(await c.probe("/api/reach/v1/profiles", { per_page: 5 }));

  const probedProfile = out.probes[1];
  if (probedProfile.itemCount === 0 && probedProfile.ok) {
    out.findings.push({
      level: "warn",
      text: "Der Reach-Endpunkt antwortet mit HTTP 200, liefert aber keine Profile. Entweder ist im Konto kein Reach-Profil angelegt, oder das API-Token deckt den Reach-Bereich nicht ab. Ein Token wird im hPanel mit ausgewählten Bereichen erzeugt - fehlt „Reach“, kommt genau diese leere Liste.",
    });
  }

  const mailProbe = out.probes[0];
  if (!mailProbe.ok) {
    out.findings.push({
      level: "warn",
      text: `Der Mail-Endpunkt antwortet mit HTTP ${mailProbe.status}${mailProbe.message ? `: ${mailProbe.message}` : ""}. 401 heißt ungültiges Token, 403 fehlende Berechtigung für den Mail-Bereich, 404 kein solches Produkt im Konto.`,
    });
  } else if (mailProbe.itemCount === 0) {
    out.findings.push({
      level: "warn",
      text: "Der Mail-Endpunkt antwortet mit HTTP 200, liefert aber keine Bestellung. Entweder gibt es bei Hostinger kein Mail-Produkt, oder das Token deckt den Mail-Bereich nicht ab.",
    });
  }

  // --- Mail-Bestellungen und deren Postfaecher
  try {
    const orders = await fetchAllPages((page) => c.listMailOrders({ page, per_page: 50 }));
    out.tokenOk = true;

    for (const o of orders) {
      let count = 0;
      try {
        count = (await fetchAllPages((page) => c.listMailboxes(o.id, { page, per_page: 100 })))
          .length;
      } catch {
        count = -1; // nicht lesbar
      }
      out.mailOrders.push({
        id: String(o.id),
        domain: o.domain,
        status: o.status,
        mailboxes: count,
      });
    }

    if (orders.length === 0) {
      out.findings.push({
        level: "warn",
        text: "Das Token ist gültig, aber im Hostinger-Konto liegt keine Mail-Bestellung. Das Postfach-Einlesen kann deshalb nichts finden — es gibt bei Hostinger keine Postfächer. Absender bitte unter „Absender“ manuell anlegen; ein Postfach bei einem anderen Anbieter (z. B. all-inkl mit smtp-Server w0…​.kasserver.com) funktioniert genauso.",
      });
    } else {
      const withBoxes = out.mailOrders.filter((o) => o.mailboxes > 0);
      if (withBoxes.length === 0) {
        out.findings.push({
          level: "warn",
          text: `${orders.length} Mail-Bestellung(en) gefunden, aber ohne angelegte Postfächer. Postfächer werden im hPanel erstellt, nicht hier.`,
        });
      } else {
        out.findings.push({
          level: "ok",
          text: `${withBoxes.reduce((n, o) => n + o.mailboxes, 0)} Postfach/Postfächer gefunden — „Postfächer aus Hostinger laden“ auf der Absender-Seite zeigt sie an.`,
        });
      }
    }
  } catch (e) {
    out.tokenError = e instanceof Error ? e.message : String(e);
    out.findings.push({
      level: "warn",
      text: `Die Mail-API antwortet nicht wie erwartet: ${out.tokenError}. Häufigste Ursache: das Token hat keine Berechtigung für den Mail-Bereich.`,
    });
  }

  // --- Reach-Profile (Kontakte, DNS-Status)
  try {
    // Nicht fetchAllPages: der Endpunkt liefert Abonnements, deren Profile
    // verschachtelt liegen. extractReachProfiles() geht diese Ebene tiefer.
    const profiles = extractReachProfiles(await c.listReachProfiles({ per_page: 50 }));
    out.reachProfiles = profiles.map((p) => ({
      uuid: p.uuid,
      name: p.name ?? p.domain ?? p.uuid,
    }));
    if (profiles.length === 0) {
      out.findings.push({
        level: "warn",
        text: "Kein Hostinger-Reach-Profil vorhanden. Damit gibt es weder Kontakte zum Übernehmen noch einen SPF/DKIM-Check über die API. Empfängerlisten bitte per CSV-Import oder „Kontakt hinzufügen“ pflegen — das ist der übliche Weg und unabhängig von Hostinger.",
      });
    } else {
      out.findings.push({
        level: "ok",
        text: `${profiles.length} Reach-Profil(e) gefunden: ${out.reachProfiles.map((p) => p.name).join(", ")}.`,
      });
    }
  } catch (e) {
    out.findings.push({
      level: "info",
      text: `Reach-API nicht abrufbar: ${e instanceof Error ? e.message : String(e)}. Ohne Reach entfallen nur Kontakt-Import und DNS-Check.`,
    });
  }

  out.findings.push({
    level: "info",
    text: "Zur Einordnung: der Versand selbst läuft immer über SMTP und braucht die Hostinger-API nicht. Sie liefert nur Komfort (Postfächer einlesen, Limits, DNS-Check) und Kontrolle (Abgleich der Zustell-Logs).",
  });

  return out;
}

/** Test des hinterlegten Tokens. */
export async function testApiToken(): Promise<{ ok: boolean; message: string }> {
  try {
    const c = await client();
    const res = await c.ping();
    return { ok: true, message: `Verbindung erfolgreich - ${res.orders} Mail-Bestellung(en) gefunden.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
