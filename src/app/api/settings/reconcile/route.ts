import { getSession } from "@/lib/session";
import { isAdmin } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import { reconcileDelivery } from "@/lib/hostingerSync";

/** Gesendete Mails gegen das Hostinger-Outbound-Log abgleichen. */
export async function POST(req: Request): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");
  if (!isAdmin(session)) return backWithError("/settings", "Keine Berechtigung.");

  const form = await req.formData();
  const hoursBack = Number(form.get("hoursBack") ?? 24);

  try {
    const res = await reconcileDelivery({
      hoursBack: Number.isFinite(hoursBack) ? Math.min(168, Math.max(1, hoursBack)) : 24,
    });
    await audit({
      action: "delivery.reconcile",
      detail: `geprüft ${res.checked}, bestätigt ${res.confirmed}, fehlgeschlagen ${res.failedAtProvider}`,
      userId: session.uid,
    });

    if (res.note) return backWithOk("/settings", res.note);
    return backWithOk(
      "/settings",
      `Abgleich fertig — ${res.confirmed} bestätigt, ${res.failedAtProvider} laut Hostinger fehlgeschlagen, ${res.unmatched} noch ohne Log-Eintrag.`
    );
  } catch (e) {
    return backWithError("/settings", errorMessage(e));
  }
}
