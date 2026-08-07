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

const PUBLIC_PREFIXES = ["/login", "/abmelden", "/api/auth/login", "/api/cron"];

export function middleware(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  if (!req.cookies.get(SESSION_COOKIE)?.value) {
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|ico|webmanifest)$).*)"],
};
