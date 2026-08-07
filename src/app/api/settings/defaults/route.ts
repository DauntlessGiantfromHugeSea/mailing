import { getSession } from "@/lib/session";
import { isAdmin } from "@/lib/rbac";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { setSetting, SETTINGS } from "@/lib/settings";

export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!isAdmin(session)) return backWithError("/settings", "Keine Berechtigung.");

  const form = await req.formData();
  const timezone = String(form.get("timezone") ?? "").trim() || "Europe/Berlin";

  // Zeitzone gegen Intl prüfen, damit keine kaputte Zone gespeichert wird.
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: timezone });
  } catch {
    return backWithError("/settings", `Unbekannte Zeitzone: ${timezone}`);
  }

  try {
    await setSetting(SETTINGS.defaultTimezone, timezone);
    await setSetting(
      SETTINGS.defaultIntervalMinutes,
      String(clampInt(form.get("intervalMinutes"), 3, 1, 1440))
    );
    await setSetting(
      SETTINGS.defaultJitterPercent,
      String(clampInt(form.get("jitterPercent"), 60, 0, 100))
    );
    return backWithOk("/settings", "Standardwerte gespeichert.");
  } catch (e) {
    return backWithError("/settings", errorMessage(e));
  }
}

function clampInt(raw: FormDataEntryValue | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}
