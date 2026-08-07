import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Role } from "@prisma/client";

// Anmeldung über Microsoft Entra ID (ehemals Azure AD), OpenID Connect mit
// Authorization Code Flow + PKCE.
//
// Bewusst ohne zusätzliche Auth-Bibliothek: gebraucht werden nur zwei
// Redirects und eine Token-Prüfung, und `jose` ist für die Sessions schon da.
//
// Konfiguration (alle Werte aus der Entra-App-Registrierung):
//   MICROSOFT_TENANT_ID       Verzeichnis-ID (GUID) - bewusst KEIN "common",
//                             damit sich nicht beliebige Microsoft-Konten
//                             anmelden können.
//   MICROSOFT_CLIENT_ID       Anwendungs-ID (GUID)
//   MICROSOFT_CLIENT_SECRET   Geheimer Clientschlüssel
//
// Zugriffssteuerung:
//   MICROSOFT_ALLOWED_DOMAINS   z.B. "fb-eng.de,rss-fb.com" - leer = alle
//                               Konten des Tenants sind zugelassen
//   MICROSOFT_AUTO_PROVISION    "1" = unbekannte Adressen werden angelegt,
//                               sonst muss der Benutzer bereits existieren
//   MICROSOFT_DEFAULT_ROLE      Rolle für neu angelegte Konten (Default VIEWER)

export interface MicrosoftConfig {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  allowedDomains: string[];
  autoProvision: boolean;
  defaultRole: Role;
}

/**
 * Raeumt einen aus der Anleitung kopierten Wert auf.
 *
 * Platzhalter werden in Dokumentationen oft als <Verzeichnis-ID> geschrieben.
 * Bleiben die spitzen Klammern beim Einsetzen stehen, antwortet Microsoft mit
 * "AADSTS900023: Specified tenant identifier ... is neither a valid DNS name",
 * und die Ursache ist an der Meldung schwer zu erkennen. Da weder GUIDs noch
 * Domainnamen noch Microsoft-Clientschluessel spitze Klammern oder
 * Anfuehrungszeichen enthalten, koennen sie gefahrlos entfernt werden.
 */
function cleanEnvValue(raw: string | undefined): string {
  let v = (raw ?? "").trim();
  // Umschliessende Anfuehrungszeichen (falls die .env doppelt gequotet wurde).
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1).trim();
  }
  // Umschliessende spitze Klammern - nur als Paar, um echte Werte nicht zu
  // beschaedigen.
  if (v.startsWith("<") && v.endsWith(">")) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

/** null = Microsoft-Login ist nicht konfiguriert. */
export function microsoftConfig(): MicrosoftConfig | null {
  const tenantId = cleanEnvValue(process.env.MICROSOFT_TENANT_ID);
  const clientId = cleanEnvValue(process.env.MICROSOFT_CLIENT_ID);
  const clientSecret = cleanEnvValue(process.env.MICROSOFT_CLIENT_SECRET);
  if (!tenantId || !clientId || !clientSecret) return null;

  const roleRaw = (process.env.MICROSOFT_DEFAULT_ROLE ?? "VIEWER").trim().toUpperCase();
  const defaultRole: Role =
    roleRaw === "ADMIN" || roleRaw === "EDITOR" ? (roleRaw as Role) : ("VIEWER" as Role);

  return {
    tenantId,
    clientId,
    clientSecret,
    allowedDomains: (process.env.MICROSOFT_ALLOWED_DOMAINS ?? "")
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
    autoProvision: process.env.MICROSOFT_AUTO_PROVISION === "1",
    defaultRole,
  };
}

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * Prueft die Konfiguration auf offensichtliche Fehler, BEVOR zu Microsoft
 * weitergeleitet wird. Ohne diese Pruefung landet der Benutzer auf einer
 * AADSTS-Fehlerseite, deren Meldung die eigentliche Ursache (etwa ein
 * mitkopierter Platzhalter) nur indirekt erkennen laesst.
 *
 * null = keine Auffaelligkeit.
 */
export function configProblem(cfg: MicrosoftConfig): string | null {
  const multiTenant = ["common", "organizations", "consumers"].includes(
    cfg.tenantId.toLowerCase()
  );

  if (!multiTenant && !GUID_RE.test(cfg.tenantId) && !DOMAIN_RE.test(cfg.tenantId)) {
    return `MICROSOFT_TENANT_ID ist ungültig: "${cfg.tenantId}". Erwartet wird die Verzeichnis-ID als GUID (z. B. 670bb529-17d4-49c9-aed1-9d79198ee1da) oder ein Domainname. Häufigste Ursache: beim Kopieren aus der Anleitung sind spitze Klammern oder Anführungszeichen mitgekommen.`;
  }
  if (multiTenant && cfg.allowedDomains.length === 0) {
    return `MICROSOFT_TENANT_ID ist auf "${cfg.tenantId}" gesetzt. Damit könnte sich jedes Microsoft-Konto anmelden. Bitte die konkrete Verzeichnis-ID eintragen, oder wenigstens MICROSOFT_ALLOWED_DOMAINS setzen.`;
  }
  if (!GUID_RE.test(cfg.clientId)) {
    return `MICROSOFT_CLIENT_ID ist ungültig: "${cfg.clientId}". Erwartet wird die Anwendungs-ID als GUID — ebenfalls ohne spitze Klammern.`;
  }
  if (cfg.clientSecret.length < 8) {
    return "MICROSOFT_CLIENT_SECRET sieht zu kurz aus. Erwartet wird der Wert des Clientschlüssels, nicht dessen ID (im Portal gibt es beides — gebraucht wird die Spalte „Wert“).";
  }
  return null;
}

/** Ist die Anmeldung per Passwort erlaubt? Default ja. */
export function localLoginEnabled(): boolean {
  return process.env.AUTH_LOCAL_ENABLED !== "false";
}

export function appUrl(): string {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export function redirectUri(): string {
  return `${appUrl()}/api/auth/microsoft/callback`;
}

function base(tenantId: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}`;
}

// --------------------------------------------------------------------- PKCE

export function randomUrlSafe(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export function codeChallenge(verifier: string): string {
  return crypto.createHash("sha256").update(verifier).digest("base64url");
}

export function authorizeUrl(
  cfg: MicrosoftConfig,
  params: { state: string; nonce: string; verifier: string }
): string {
  const url = new URL(`${base(cfg.tenantId)}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", codeChallenge(params.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  // Nur Geschäfts-/Schulkonten des Tenants.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

// ------------------------------------------------------------ Token-Tausch

export class MicrosoftAuthError extends Error {}

interface TokenResponse {
  id_token?: string;
  access_token?: string;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(
  cfg: MicrosoftConfig,
  code: string,
  verifier: string
): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(),
    code_verifier: verifier,
    scope: "openid profile email",
  });

  const res = await fetch(`${base(cfg.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });

  const data = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !data.id_token) {
    throw new MicrosoftAuthError(
      data.error_description ?? data.error ?? `Token-Endpunkt antwortete mit ${res.status}`
    );
  }
  return data.id_token;
}

// ------------------------------------------------------------ ID-Token-Prüfung

// JWKS pro Tenant zwischenspeichern - createRemoteJWKSet cacht die Schlüssel
// selbst und erneuert sie bei unbekannter kid.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwks(tenantId: string) {
  const cached = jwksCache.get(tenantId);
  if (cached) return cached;
  const set = createRemoteJWKSet(new URL(`${base(tenantId)}/discovery/v2.0/keys`));
  jwksCache.set(tenantId, set);
  return set;
}

export interface MicrosoftIdentity {
  oid: string;
  email: string;
  name: string;
  tenantId: string;
}

interface MsClaims extends JWTPayload {
  oid?: string;
  tid?: string;
  name?: string;
  email?: string;
  preferred_username?: string;
  nonce?: string;
}

/**
 * Prüft Signatur, Aussteller, Zielgruppe, Tenant und Nonce. Alles davon ist
 * nötig: ohne Nonce-Prüfung wäre ein wiedereingespieltes Token verwendbar,
 * ohne Tenant-Prüfung könnte sich ein fremdes Verzeichnis anmelden.
 */
export async function verifyIdToken(
  cfg: MicrosoftConfig,
  idToken: string,
  expectedNonce: string
): Promise<MicrosoftIdentity> {
  let payload: MsClaims;
  try {
    const result = await jwtVerify(idToken, jwks(cfg.tenantId), {
      audience: cfg.clientId,
    });
    payload = result.payload as MsClaims;
  } catch (e) {
    throw new MicrosoftAuthError(
      `ID-Token konnte nicht verifiziert werden: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  const tid = payload.tid;
  if (!tid) throw new MicrosoftAuthError("ID-Token enthält keine Tenant-ID (tid).");

  // Aussteller muss zum Tenant des Tokens passen.
  const expectedIssuer = `https://login.microsoftonline.com/${tid}/v2.0`;
  if (payload.iss !== expectedIssuer) {
    throw new MicrosoftAuthError(`Unerwarteter Aussteller: ${payload.iss}`);
  }

  // Ist MICROSOFT_TENANT_ID eine GUID, muss sie exakt passen. Bei einem
  // Domainnamen als Tenant-Bezeichner lässt sich das nicht vergleichen -
  // dann greift die Domain-Allowlist.
  const isGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    cfg.tenantId
  );
  if (isGuid && tid.toLowerCase() !== cfg.tenantId.toLowerCase()) {
    throw new MicrosoftAuthError("Anmeldung aus einem fremden Microsoft-Verzeichnis.");
  }

  if (!payload.nonce || payload.nonce !== expectedNonce) {
    throw new MicrosoftAuthError("Nonce stimmt nicht - Anmeldung bitte neu starten.");
  }

  const email = (payload.email ?? payload.preferred_username ?? "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    throw new MicrosoftAuthError(
      "Das Microsoft-Konto liefert keine E-Mail-Adresse. In der App-Registrierung muss der optionale Claim 'email' aktiviert sein."
    );
  }
  if (!payload.oid) throw new MicrosoftAuthError("ID-Token enthält keine Objekt-ID (oid).");

  return {
    oid: payload.oid,
    email,
    name: (payload.name ?? email.split("@")[0]).trim(),
    tenantId: tid,
  };
}

/** Prüft die Domain-Allowlist. Leere Liste = jede Adresse des Tenants. */
export function domainAllowed(cfg: MicrosoftConfig, email: string): boolean {
  if (cfg.allowedDomains.length === 0) return true;
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return cfg.allowedDomains.includes(domain);
}
