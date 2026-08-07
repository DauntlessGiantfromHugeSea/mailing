import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

// Grober Zugriffsschutz: alles ausser Login, Abmeldeseite und Cron braucht ein
// Session-Cookie. Die eigentliche Pruefung (Signatur, Rolle) passiert in den
// Seiten und Routen - hier geht es nur darum, Unangemeldete frueh umzuleiten.
//
// Die Signatur wird bewusst NICHT hier geprueft: das Middleware-Runtime ist
// Edge, und jose/HS256 dort zu verifizieren wuerde den Session-Secret in die
// Edge-Umgebung ziehen. getSession() in den Server-Komponenten macht die
// verbindliche Pruefung.

// "/api/auth" deckt login, logout und den Microsoft-Flow ab. Der
// OIDC-Rücksprung /api/auth/microsoft/callback erfolgt zwangsläufig ohne
// Session - stünde er nicht hier, würde die Middleware ihn auf /login
// umleiten und die Anmeldung könnte nie abgeschlossen werden.
const PUBLIC_PREFIXES = ["/login", "/abmelden", "/api/auth", "/api/cron"];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    return NextResponse.redirect(loginUrl(req));
  }

  return NextResponse.next();
}

/**
 * Baut die absolute Login-URL.
 *
 * Die Middleware MUSS eine absolute URL zurückgeben - ein relativer
 * Location-Header wird von Next.js als NextURL geparst und wirft
 * "Invalid URL". Hinter einem Reverse Proxy kennt `req.nextUrl` aber nur die
 * interne Verbindung (http://app:3000), nicht die öffentliche Adresse. Ohne
 * Korrektur würde der Browser auf http://app:3000/login geschickt.
 *
 * Deshalb werden `X-Forwarded-Proto` und `X-Forwarded-Host` bevorzugt, die
 * Caddy und nginx setzen. Fehlen sie (lokale Entwicklung), bleibt es bei
 * `req.nextUrl`.
 */
function loginUrl(req: NextRequest): URL {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";

  // Bei mehreren Proxys stehen die Werte kommagetrennt; der erste ist der
  // ursprüngliche Client-Request.
  const first = (v: string | null): string | null => v?.split(",")[0]?.trim() || null;
  const proto = first(req.headers.get("x-forwarded-proto"));
  const host = first(req.headers.get("x-forwarded-host")) ?? first(req.headers.get("host"));

  if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
  if (host) {
    if (host.includes(":")) {
      // Host bringt einen eigenen Port mit (lokale Entwicklung, z.B.
      // "127.0.0.1:3000") - host setzt dann Hostname und Port zusammen.
      url.host = host;
    } else {
      // Ohne Port im Header: den internen Port explizit entfernen, sonst
      // bliebe er stehen und der Browser landete auf mailing.example.com:3000.
      url.hostname = host;
      url.port = "";
    }
  }
  return url;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webmanifest)$).*)"],
};
