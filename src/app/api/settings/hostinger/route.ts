import { getSession } from "@/lib/session";
import { isAdmin } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { deleteSetting, setSetting, SETTINGS } from "@/lib/settings";
import { testApiToken } from "@/lib/hostingerSync";

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!isAdmin(session)) return backWithError("/settings", "Keine Berechtigung.");

  const form = await req.formData();
  const intent = String(form.get("intent") ?? "save");

  try {
    if (intent === "clear") {
      await deleteSetting(SETTINGS.hostingerToken);
      await audit({ action: "settings.hostingerTokenCleared", userId: session.uid });
      return backWithOk("/settings", "API-Token entfernt.");
    }

    // Leeres Token-Feld = vorhandenes Token beibehalten.
    const token = String(form.get("apiToken") ?? "").trim();
    if (token) {
      await setSetting(SETTINGS.hostingerToken, token, true);
      await audit({ action: "settings.hostingerTokenSaved", userId: session.uid });
    }

    const reach = String(form.get("reachProfileUuid") ?? "").trim();
    const order = String(form.get("mailOrderId") ?? "").trim();
    if (reach) await setSetting(SETTINGS.reachProfileUuid, reach);
    else await deleteSetting(SETTINGS.reachProfileUuid);
    if (order) await setSetting(SETTINGS.mailOrderId, order);
    else await deleteSetting(SETTINGS.mailOrderId);

    if (intent === "test") {
      const res = await testApiToken();
      return res.ok ? backWithOk("/settings", res.message) : backWithError("/settings", res.message);
    }

    return backWithOk("/settings", "Einstellungen gespeichert.");
  } catch (e) {
    return backWithError("/settings", errorMessage(e));
  }
}
