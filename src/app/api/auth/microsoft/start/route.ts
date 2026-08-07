import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  authorizeUrl,
  configProblem,
  microsoftConfig,
  randomUrlSafe,
} from "@/lib/authMicrosoft";
import { backWithError } from "@/lib/http";

// Schritt 1: State, Nonce und PKCE-Verifier erzeugen, in kurzlebigen Cookies
// ablegen und zu Microsoft weiterleiten.
//
// sameSite "lax" ist hier richtig und nötig: der Rücksprung von Microsoft ist
// eine Top-Level-Navigation, bei "strict" käme das Cookie nicht mit und jede
// Anmeldung schlüge fehl.

export const dynamic = "force-dynamic";

const TEN_MINUTES = 60 * 10;

export async function GET(): Promise<Response> {
  const cfg = microsoftConfig();
  if (!cfg) {
    return backWithError(
      "/login",
      "Microsoft-Anmeldung ist nicht konfiguriert (MICROSOFT_TENANT_ID / _CLIENT_ID / _CLIENT_SECRET fehlen)."
    );
  }

  // Konfiguration prüfen, bevor der Benutzer zu Microsoft geschickt wird -
  // sonst bekommt er dort eine AADSTS-Meldung, aus der die eigentliche Ursache
  // nur schwer hervorgeht.
  const problem = configProblem(cfg);
  if (problem) return backWithError("/login", problem);

  const state = randomUrlSafe();
  const nonce = randomUrlSafe();
  const verifier = randomUrlSafe(48);

  const jar = cookies();
  const opts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: TEN_MINUTES,
  };
  jar.set("ms_state", state, opts);
  jar.set("ms_nonce", nonce, opts);
  jar.set("ms_verifier", verifier, opts);

  return NextResponse.redirect(authorizeUrl(cfg, { state, nonce, verifier }));
}
