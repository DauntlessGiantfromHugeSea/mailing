import { prisma } from "./db";
import { blindIndex, encryptField, randomToken, safeDecrypt } from "./crypto";
import type { Contact } from "@prisma/client";

// Kontaktverwaltung inkl. CSV-Import.

export interface ContactInput {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  customFields?: Record<string, string> | null;
  tags?: string[];
  source?: string;
  reachContactUuid?: string | null;
}

export interface UpsertStats {
  created: number;
  updated: number;
  skipped: number;
  suppressed: number;
  invalid: string[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

/**
 * Legt Kontakte an oder aktualisiert sie (idempotent ueber emailHash).
 * Adressen auf der Sperrliste werden nicht wieder aktiviert - eine Abmeldung
 * darf ein CSV-Reimport nicht aushebeln.
 */
export async function upsertContacts(
  inputs: ContactInput[],
  opts: { listId?: string | null } = {}
): Promise<UpsertStats> {
  const stats: UpsertStats = { created: 0, updated: 0, skipped: 0, suppressed: 0, invalid: [] };

  const suppressed = new Set(
    (await prisma.suppression.findMany({ select: { emailHash: true } })).map((s) => s.emailHash)
  );

  // Duplikate innerhalb der Eingabe zusammenfassen (letzter Eintrag gewinnt).
  const byHash = new Map<string, ContactInput>();
  for (const input of inputs) {
    const email = input.email?.trim().toLowerCase() ?? "";
    if (!isValidEmail(email)) {
      stats.invalid.push(input.email ?? "(leer)");
      continue;
    }
    byHash.set(blindIndex(email), { ...input, email });
  }

  for (const [hash, input] of byHash) {
    if (suppressed.has(hash)) {
      stats.suppressed++;
      continue;
    }

    const existing = await prisma.contact.findUnique({ where: { emailHash: hash } });
    const data = {
      firstName: input.firstName ? encryptField(input.firstName) : undefined,
      lastName: input.lastName ? encryptField(input.lastName) : undefined,
      company: input.company ? encryptField(input.company) : undefined,
      customFields:
        input.customFields && Object.keys(input.customFields).length
          ? JSON.stringify(input.customFields)
          : undefined,
      tags: input.tags && input.tags.length ? JSON.stringify(input.tags) : undefined,
      source: input.source,
      reachContactUuid: input.reachContactUuid ?? undefined,
    };

    let contact: Contact;
    if (existing) {
      contact = await prisma.contact.update({ where: { id: existing.id }, data });
      stats.updated++;
    } else {
      contact = await prisma.contact.create({
        data: {
          email: encryptField(input.email)!,
          emailHash: hash,
          unsubscribeToken: randomToken(),
          status: "ACTIVE",
          firstName: data.firstName ?? null,
          lastName: data.lastName ?? null,
          company: data.company ?? null,
          customFields: data.customFields ?? null,
          tags: data.tags ?? null,
          source: input.source ?? "manual",
          reachContactUuid: input.reachContactUuid ?? null,
        },
      });
      stats.created++;
    }

    if (opts.listId) {
      await prisma.listMembership.upsert({
        where: { listId_contactId: { listId: opts.listId, contactId: contact.id } },
        create: { listId: opts.listId, contactId: contact.id },
        update: {},
      });
    }
  }

  return stats;
}

/**
 * Minimaler CSV-Parser: Komma oder Semikolon als Trenner, Anfuehrungszeichen
 * mit "" als Escape. Bewusst ohne Zusatzabhaengigkeit.
 */
export function parseCsv(text: string): { header: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const delimiter = guessDelimiter(clean);

  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);

  const header = (rows.shift() ?? []).map((h) => h.trim());
  return { header, rows };
}

function guessDelimiter(text: string): string {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const semis = (firstLine.match(/;/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  if (tabs > semis && tabs > commas) return "\t";
  return semis > commas ? ";" : ",";
}

const FIELD_ALIASES: Record<string, string> = {
  email: "email",
  "e-mail": "email",
  "e-mail-adresse": "email",
  mail: "email",
  emailaddress: "email",
  firstname: "firstName",
  vorname: "firstName",
  "first name": "firstName",
  lastname: "lastName",
  nachname: "lastName",
  "last name": "lastName",
  name: "fullName",
  fullname: "fullName",
  company: "company",
  firma: "company",
  unternehmen: "company",
  organisation: "company",
  tags: "tags",
  tag: "tags",
};

/** Baut aus CSV-Zeilen ContactInputs. Unbekannte Spalten werden Custom-Fields. */
export function csvToContacts(
  header: string[],
  rows: string[][],
  source = "csv"
): { contacts: ContactInput[]; unmapped: string[] } {
  const mapping = header.map((h) => FIELD_ALIASES[h.trim().toLowerCase()] ?? null);
  const unmapped = header.filter((_h, i) => mapping[i] === null);

  const contacts: ContactInput[] = [];
  for (const row of rows) {
    const custom: Record<string, string> = {};
    let email = "";
    let firstName: string | null = null;
    let lastName: string | null = null;
    let company: string | null = null;
    let tags: string[] = [];

    header.forEach((rawHeader, i) => {
      const value = (row[i] ?? "").trim();
      if (!value) return;
      switch (mapping[i]) {
        case "email":
          email = value;
          break;
        case "firstName":
          firstName = value;
          break;
        case "lastName":
          lastName = value;
          break;
        case "fullName": {
          const parts = value.split(/\s+/);
          firstName = firstName ?? parts[0] ?? null;
          if (parts.length > 1) lastName = lastName ?? parts.slice(1).join(" ");
          break;
        }
        case "company":
          company = value;
          break;
        case "tags":
          tags = value
            .split(/[;,|]/)
            .map((t) => t.trim())
            .filter(Boolean);
          break;
        default:
          custom[slugKey(rawHeader)] = value;
      }
    });

    if (email) {
      contacts.push({ email, firstName, lastName, company, tags, customFields: custom, source });
    }
  }
  return { contacts, unmapped };
}

function slugKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function decryptContact(c: Contact) {
  return {
    ...c,
    emailPlain: safeDecrypt(c.email) ?? "",
    firstNamePlain: safeDecrypt(c.firstName) ?? "",
    lastNamePlain: safeDecrypt(c.lastName) ?? "",
    companyPlain: safeDecrypt(c.company) ?? "",
    tagList: c.tags ? (safeParseArray(c.tags) as string[]) : [],
  };
}

function safeParseArray(json: string): unknown[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/** Meldet einen Kontakt ab und setzt ihn auf die Sperrliste. */
export async function unsubscribeByToken(token: string): Promise<Contact | null> {
  const contact = await prisma.contact.findUnique({ where: { unsubscribeToken: token } });
  if (!contact) return null;

  const updated = await prisma.contact.update({
    where: { id: contact.id },
    data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date() },
  });
  await prisma.suppression.upsert({
    where: { emailHash: contact.emailHash },
    create: { emailHash: contact.emailHash, reason: "unsubscribe" },
    update: {},
  });
  // Noch nicht gesendete Mails an diese Adresse abbrechen.
  await prisma.sendJob.updateMany({
    where: { contactId: contact.id, status: "PENDING" },
    data: { status: "SKIPPED", error: "Empfänger hat sich abgemeldet" },
  });
  return updated;
}
