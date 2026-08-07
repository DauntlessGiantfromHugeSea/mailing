import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { createSession } from "@/lib/session";
import { audit } from "@/lib/audit";
import { backWithError, seeOther } from "@/lib/http";
import {
  domainAllowed,
  exchangeCode,
  microsoftConfig,
  verifyIdToken,
  MicrosoftAuthError,
} from "@/lib/authMicrosoft";

// Schritt 2: Rücksprung von Microsoft. Prüft State, tauscht den Code gegen ein
// ID-Token, verifiziert es und legt die Session an.

export const dynamic = "force-dynamic";

function clearFlowCookies(): void {
  const jar = cookies();
  for (const name of ["ms_state", "ms_nonce", "ms_verifier"]) {
    jar.set(name, "", { path: "/", maxAge: 0 });
  }
}

export async function GET(req: Request): Promise<Response> {
  const cfg = microsoftConfig();
  if (!cfg) return backWithError("/login", "Microsoft-Anmeldung ist nicht konfiguriert.");

  const url = new URL(req.url);

  // Microsoft meldet Abbrüche und Fehler als Query-Parameter zurück.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    clearFlowCookies();
    const desc = url.searchParams.get("error_description") ?? oauthError;
    if (oauthError === "access_denied") {
      return backWithError("/login", "Anmeldung bei Microsoft abgebrochen.");
    }
    return backWithError("/login", `Microsoft meldet: ${desc}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const jar = cookies();
  const expectedState = jar.get("ms_state")?.value;
  const nonce = jar.get("ms_nonce")?.value;
  const verifier = jar.get("ms_verifier")?.value;

  if (!code || !state || !expectedState || !nonce || !verifier) {
    clearFlowCookies();
    return backWithError(
      "/login",
      "Anmeldevorgang unvollständig oder abgelaufen. Bitte erneut versuchen."
    );
  }
  if (state !== expectedState) {
    clearFlowCookies();
    return backWithError("/login", "State stimmt nicht — Anmeldung abgebrochen.");
  }

  try {
    const idToken = await exchangeCode(cfg, code, verifier);
    const identity = await verifyIdToken(cfg, idToken, nonce);
    clearFlowCookies();

    if (!domainAllowed(cfg, identity.email)) {
      await audit({
        action: "auth.microsoftRejected",
        detail: `Domain nicht zugelassen: ${identity.email}`,
      });
      return backWithError(
        "/login",
        `Für ${identity.email} ist kein Zugang eingerichtet (Domain nicht zugelassen).`
      );
    }

    // Zuordnung: erst über die stabile Objekt-ID, dann über die E-Mail.
    let user =
      (await prisma.user.findFirst({ where: { msOid: identity.oid } })) ??
      (await prisma.user.findUnique({ where: { email: identity.email } }));

    if (!user) {
      if (!cfg.autoProvision) {
        await audit({
          action: "auth.microsoftRejected",
          detail: `Kein Konto für ${identity.email} (Auto-Provisionierung aus)`,
        });
        return backWithError(
          "/login",
          `Für ${identity.email} existiert kein Konto. Entweder die E-Mail des vorhandenen Kontos auf diese Adresse ändern, oder MICROSOFT_AUTO_PROVISION=1 setzen.`
        );
      }
      user = await prisma.user.create({
        data: {
          email: identity.email,
          name: identity.name,
          // Kein Passwort: leerer Hash schlägt bei jedem bcrypt-Vergleich fehl.
          passwordHash: "",
          role: cfg.defaultRole,
          active: true,
          msOid: identity.oid,
          lastLoginVia: "microsoft",
        },
      });
      await audit({
        action: "auth.microsoftProvisioned",
        entity: "User",
        entityId: user.id,
        detail: `${identity.email} als ${cfg.defaultRole}`,
        userId: user.id,
      });
    }

    if (!user.active) {
      return backWithError("/login", "Dieses Konto ist deaktiviert.");
    }

    // Objekt-ID nachtragen bzw. Namen aktualisieren.
    user = await prisma.user.update({
      where: { id: user.id },
      data: {
        msOid: identity.oid,
        name: user.name || identity.name,
        lastLoginAt: new Date(),
        lastLoginVia: "microsoft",
      },
    });

    await createSession({
      uid: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
    });
    await audit({
      action: "auth.microsoftLogin",
      entity: "User",
      entityId: user.id,
      userId: user.id,
    });

    return seeOther("/dashboard");
  } catch (e) {
    clearFlowCookies();
    if (e instanceof MicrosoftAuthError) return backWithError("/login", e.message);
    return backWithError(
      "/login",
      `Anmeldung fehlgeschlagen: ${e instanceof Error ? e.message : String(e)}`
    );
  }
}
