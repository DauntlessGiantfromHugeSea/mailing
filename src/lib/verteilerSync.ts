import crypto from "node:crypto";
import { z } from "zod";
import { prisma } from "./db";
import { blindIndex } from "./crypto";
import { isValidEmail, upsertContacts } from "./contacts";
import { audit } from "./audit";

// Abgleich mit dem E-Mail-Verteiler (intern.rss-fb.com/verteiler).
//
// Der Verteiler ist die führende Kontaktdatenbank. Er ruft regelmäßig
// POST /api/integration/verteiler auf und
//   1. übergibt seine Sperrliste  -> landet hier auf der Sperrliste, offene
//      Sendungen an diese Adressen werden abgebrochen,
//   2. übergibt optional die Empfänger einer Liste -> diese Liste wird hier
//      exakt auf diesen Stand gebracht (anlegen/aktualisieren/entfernen),
//   0. übergibt DSGVO-Löschungen (`erase`) -> der Kontakt wird hier ebenfalls
//      gelöscht (Abmeldelinks bleiben gültig, Sperre nach Wahl des Verteilers),
//   3. fragt für seine aktiven Adressen ab, ob sie HIER gesperrt sind
//      (Abmeldelink, Bounce, Beschwerde) -> Antwort geht zurück in den Verteiler.
//
// Absicherung: Bearer-Token VERTEILER_SYNC_TOKEN (min. 32 Zeichen). Ohne Token
// ist der Endpunkt abgeschaltet. Klartext-Adressen werden hier nicht neu
// gespeichert - Sperren nur als Blind-Index, Kontakte verschlüsselt wie immer.

export const SYNC_NOTE = "Verteiler";

const REASON_FROM_GRUND = {
  bounce_hart: "bounce",
  abgemeldet: "unsubscribe",
  beschwerde: "complaint",
  manuell: "manual",
} as const;

const STATUS_FOR_REASON = {
  bounce: "BOUNCED",
  unsubscribe: "UNSUBSCRIBED",
  complaint: "COMPLAINED",
  manual: "SUPPRESSED",
} as const;

const GRUND_FROM_REASON: Record<string, string> = {
  bounce: "bounce_hart",
  unsubscribe: "abgemeldet",
  complaint: "beschwerde",
  manual: "manuell",
};

const MAX_ITEMS = 200_000;
const CHUNK = 1000;

export function syncEnabled(): boolean {
  return (process.env.VERTEILER_SYNC_TOKEN ?? "").length >= 32;
}

/** Zeitkonstanter Token-Vergleich (über SHA-256, damit die Länge nichts verrät). */
export function tokenOk(provided: string): boolean {
  const expected = process.env.VERTEILER_SYNC_TOKEN ?? "";
  if (expected.length < 32 || !provided) return false;
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

const text = (max: number) => z.string().max(max).nullable().optional();

export const syncSchema = z.object({
  list: z
    .object({
      name: z.string().trim().min(1).max(120),
      contacts: z
        .array(
          z.object({
            email: z.string().max(254),
            firstName: text(200),
            lastName: text(200),
            company: text(200),
          })
        )
        .max(MAX_ITEMS),
    })
    .nullable()
    .optional(),
  suppress: z
    .array(
      z.object({
        email: z.string().max(254),
        reason: z.enum(["bounce_hart", "abgemeldet", "beschwerde", "manuell"]),
      })
    )
    .max(MAX_ITEMS)
    .default([]),
  check: z.array(z.string().max(254)).max(MAX_ITEMS).default([]),
  erase: z
    .array(z.object({ email: z.string().max(254), keepSuppression: z.boolean().default(true) }))
    .max(MAX_ITEMS)
    .default([]),
});

export type SyncInput = z.infer<typeof syncSchema>;

export interface SyncResult {
  /** DSGVO-Löschungen verarbeitet (Anzahl übergebener Adressen; gelöscht = hier vorhanden). */
  erased: { received: number; contactsDeleted: number; suppressionsRemoved: number };
  suppressionsAdded: number;
  contactsBlocked: number;
  jobsSkipped: number;
  list: null | {
    id: string;
    name: string;
    created: number;
    updated: number;
    suppressed: number;
    invalid: number;
    members: number;
    removed: number;
  };
  /** Adressen aus `check`, die hier gesperrt sind (nicht vom Verteiler selbst). */
  suppressions: { email: string; grund: string; since: string }[];
}

function norm(email: string): string | null {
  const e = email.trim().toLowerCase();
  return isValidEmail(e) ? e : null;
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runSync(input: SyncInput): Promise<SyncResult> {
  const result: SyncResult = {
    erased: { received: 0, contactsDeleted: 0, suppressionsRemoved: 0 },
    suppressionsAdded: 0,
    contactsBlocked: 0,
    jobsSkipped: 0,
    list: null,
    suppressions: [],
  };

  // ------------------------------------------- 0. DSGVO-Löschungen übernehmen
  // Vor den Sperren, damit eine gleichzeitig übergebene Sperre für dieselbe
  // Adresse danach wieder angelegt wird.
  const erase = new Map<string, boolean>();
  for (const x of input.erase) {
    const e = norm(x.email);
    if (e) erase.set(blindIndex(e), x.keepSuppression);
  }
  result.erased.received = erase.size;
  for (const part of chunks([...erase.keys()])) {
    const contacts = await prisma.contact.findMany({
      where: { emailHash: { in: part } },
      select: { id: true, emailHash: true, unsubscribeToken: true },
    });
    for (const c of contacts) {
      // Abmeldelink aus bereits verschickten Mails bleibt gültig.
      await prisma.retiredUnsubscribeToken.upsert({
        where: { token: c.unsubscribeToken },
        create: { token: c.unsubscribeToken, emailHash: c.emailHash },
        update: {},
      });
    }
    if (contacts.length) {
      // SendJobs und Listen-Mitgliedschaften hängen per Cascade daran.
      result.erased.contactsDeleted += (
        await prisma.contact.deleteMany({ where: { id: { in: contacts.map((c) => c.id) } } })
      ).count;
    }
    // Sperre nur entfernen, wenn der Verteiler das will UND sie von ihm stammt -
    // eigene Abmeldungen/Beschwerden dieses Tools bleiben bestehen.
    const ohneSperre = part.filter((h) => erase.get(h) === false);
    if (ohneSperre.length) {
      result.erased.suppressionsRemoved += (
        await prisma.suppression.deleteMany({
          where: { emailHash: { in: ohneSperre }, note: SYNC_NOTE },
        })
      ).count;
    }
  }

  // ---------------------------------------------------- 1. Sperren übernehmen
  const wanted = new Map<string, keyof typeof STATUS_FOR_REASON>();
  for (const s of input.suppress) {
    const e = norm(s.email);
    if (e) wanted.set(blindIndex(e), REASON_FROM_GRUND[s.reason]);
  }
  if (wanted.size) {
    const known = new Set<string>();
    for (const part of chunks([...wanted.keys()])) {
      const rows = await prisma.suppression.findMany({
        where: { emailHash: { in: part } },
        select: { emailHash: true },
      });
      rows.forEach((r) => known.add(r.emailHash));
    }
    const fresh = [...wanted].filter(([hash]) => !known.has(hash));
    for (const part of chunks(fresh)) {
      const created = await prisma.suppression.createMany({
        data: part.map(([emailHash, reason]) => ({ emailHash, reason, note: SYNC_NOTE })),
        skipDuplicates: true,
      });
      result.suppressionsAdded += created.count;
    }
    // Kontakte sperren und offene Sendungen abbrechen - für alle gewünschten
    // Sperren, auch bereits bekannte (idempotent, falls ein Kontakt später kam).
    for (const part of chunks([...wanted.keys()])) {
      const contacts = await prisma.contact.findMany({
        where: { emailHash: { in: part }, status: "ACTIVE" },
        select: { id: true, emailHash: true },
      });
      for (const [reason, status] of Object.entries(STATUS_FOR_REASON)) {
        const ids = contacts.filter((c) => wanted.get(c.emailHash) === reason).map((c) => c.id);
        if (!ids.length) continue;
        const upd = await prisma.contact.updateMany({
          where: { id: { in: ids }, status: "ACTIVE" },
          data: { status },
        });
        result.contactsBlocked += upd.count;
      }
      const allIds = (
        await prisma.contact.findMany({ where: { emailHash: { in: part } }, select: { id: true } })
      ).map((c) => c.id);
      if (allIds.length) {
        const skipped = await prisma.sendJob.updateMany({
          where: { contactId: { in: allIds }, status: "PENDING" },
          data: { status: "SKIPPED", error: "Gesperrt im E-Mail-Verteiler" },
        });
        result.jobsSkipped += skipped.count;
      }
    }
  }

  // ------------------------------------------------------- 2. Liste pflegen
  if (input.list) {
    const name = input.list.name;
    const list =
      (await prisma.contactList.findFirst({ where: { name } })) ??
      (await prisma.contactList.create({
        data: {
          name,
          description:
            "Wird automatisch aus dem E-Mail-Verteiler befüllt. Änderungen von Hand " +
            "werden beim nächsten Abgleich überschrieben.",
        },
      }));

    const stats = await upsertContacts(
      input.list.contacts.map((c) => ({
        email: c.email,
        firstName: c.firstName ?? null,
        lastName: c.lastName ?? null,
        company: c.company ?? null,
        source: "verteiler",
      })),
      { listId: list.id }
    );

    // Gewünschte Mitglieder = gültige, hier nicht gesperrte Adressen der Liste
    const suppressedNow = new Set(
      (await prisma.suppression.findMany({ select: { emailHash: true } })).map((s) => s.emailHash)
    );
    const desired = new Set<string>();
    for (const c of input.list.contacts) {
      const e = norm(c.email);
      if (e) {
        const h = blindIndex(e);
        if (!suppressedNow.has(h)) desired.add(h);
      }
    }
    const members = await prisma.listMembership.findMany({
      where: { listId: list.id },
      select: { id: true, contact: { select: { emailHash: true } } },
    });
    const removeIds = members.filter((m) => !desired.has(m.contact.emailHash)).map((m) => m.id);
    let removed = 0;
    for (const part of chunks(removeIds)) {
      removed += (await prisma.listMembership.deleteMany({ where: { id: { in: part } } })).count;
    }
    result.list = {
      id: list.id,
      name: list.name,
      created: stats.created,
      updated: stats.updated,
      suppressed: stats.suppressed,
      invalid: stats.invalid.length,
      members: members.length - removed,
      removed,
    };
  }

  // ------------------------------------------- 3. Sperren hier -> Verteiler
  const asked = new Map<string, string>();
  for (const raw of input.check) {
    const e = norm(raw);
    if (e) asked.set(blindIndex(e), e);
  }
  for (const part of chunks([...asked.keys()])) {
    const rows = await prisma.suppression.findMany({
      where: { emailHash: { in: part } },
      select: { emailHash: true, reason: true, note: true, createdAt: true },
    });
    for (const r of rows) {
      if (r.note === SYNC_NOTE) continue; // kam ohnehin vom Verteiler
      result.suppressions.push({
        email: asked.get(r.emailHash)!,
        grund: GRUND_FROM_REASON[r.reason] ?? "manuell",
        since: r.createdAt.toISOString(),
      });
    }
  }

  await audit({
    action: "verteiler.sync",
    entity: "integration",
    detail:
      `DSGVO-Löschungen: ${result.erased.contactsDeleted}/${result.erased.received}, ` +
      `Sperren neu: ${result.suppressionsAdded}, Kontakte gesperrt: ${result.contactsBlocked}, ` +
      `Sendungen abgebrochen: ${result.jobsSkipped}, Rückmeldungen: ${result.suppressions.length}` +
      (result.list
        ? `, Liste „${result.list.name}“: ${result.list.members} Mitglieder (+${result.list.created} neu, -${result.list.removed})`
        : ""),
  });
  return result;
}
