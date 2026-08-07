import crypto from "node:crypto";

// AES-256-GCM Feldverschluesselung + HMAC-Blind-Index.
//
// FIELD_ENCRYPTION_KEY = 64 Hex-Zeichen (32 Byte).
//   openssl rand -hex 32
//
// Format eines verschluesselten Feldes: v1:<iv b64>:<tag b64>:<ciphertext b64>

const PREFIX = "v1";

function key(): Buffer {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      "FIELD_ENCRYPTION_KEY fehlt oder ist kein 64-stelliger Hex-String (openssl rand -hex 32)."
    );
  }
  return Buffer.from(hex, "hex");
}

export function encryptField(plain: string): string;
export function encryptField(plain: null | undefined): null;
export function encryptField(plain: string | null | undefined): string | null;
export function encryptField(plain: string | null | undefined): string | null {
  if (plain === null || plain === undefined || plain === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(":");
}

export function decryptField(value: string): string {
  const parts = value.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("Unerwartetes Ciphertext-Format");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Entschluesselt, wirft aber nicht. Gibt bei kaputten/fremden Werten null
 * zurueck, damit ein einzelner Datensatz nicht eine ganze Listenansicht kippt.
 */
export function safeDecrypt(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return decryptField(value);
  } catch {
    return null;
  }
}

/**
 * Deterministischer Hash fuer Gleichheitssuchen auf verschluesselten Feldern.
 * Nutzt denselben Key als HMAC-Secret - gleiche E-Mail ergibt immer denselben
 * Hash, ohne den Klartext zu speichern.
 */
export function blindIndex(value: string): string {
  return crypto
    .createHmac("sha256", key())
    .update(value.trim().toLowerCase(), "utf8")
    .digest("hex");
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
