// Prüfung von SMTP-Zielen (Sicherheits-Audit 2026-10): Der SMTP-Server eines
// Absenders ist frei eintragbar. Ohne Prüfung könnte die App beliebige interne
// Adressen/Ports ansprechen und deren Antworten anzeigen.
import { lookup } from "dns/promises";
import net from "net";

export const SMTP_PORTS = [25, 465, 587, 2525];

function ipv4Privat(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||      // CGNAT
    (a === 169 && b === 254) ||                // Link-local / Cloud-Metadaten
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224                                   // Multicast / reserviert
  );
}

function ipv6Privat(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x === "::" || x === "::1") return true;
  if (x.startsWith("::ffff:")) return ipv4Privat(x.slice(7));
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith("64:ff9b:") || x.startsWith("2002:");
}

export function istPrivateAdresse(ip: string): boolean {
  return net.isIPv4(ip) ? ipv4Privat(ip) : net.isIPv6(ip) ? ipv6Privat(ip) : true;
}

/** Wirft einen Error mit deutscher Meldung, wenn das Ziel nicht erlaubt ist. */
export async function assertSmtpTarget(host: string, port: number): Promise<void> {
  if (!SMTP_PORTS.includes(port)) {
    throw new Error(`SMTP-Port ${port} ist nicht erlaubt (erlaubt: ${SMTP_PORTS.join(", ")}).`);
  }
  const h = (host || "").trim();
  if (!h || !/^[a-zA-Z0-9.-]+$/.test(h) || h.length > 253) {
    throw new Error("Ungültiger SMTP-Server.");
  }
  let adressen: { address: string }[];
  try {
    adressen = net.isIP(h) ? [{ address: h }] : await lookup(h, { all: true, verbatim: true });
  } catch {
    throw new Error("SMTP-Server konnte nicht aufgelöst werden.");
  }
  if (!adressen.length || adressen.some((a) => istPrivateAdresse(a.address))) {
    throw new Error("SMTP-Server zeigt auf eine interne Adresse – nicht erlaubt.");
  }
}
