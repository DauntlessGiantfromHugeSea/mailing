import { getSession } from "@/lib/session";
import { canEdit } from "@/lib/rbac";
import { audit } from "@/lib/audit";
import { backWithError, backWithOk, errorMessage, seeOther } from "@/lib/http";
import {
  cancelCampaign,
  launchCampaign,
  pauseCampaign,
  planCampaign,
  resumeCampaign,
} from "@/lib/campaigns";

/**
 * Steuerung einer Kampagne. Ein Endpunkt fuer alle Aktionen, gesteuert ueber
 * das `action`-Feld - so bleiben es einfache HTML-Formulare ohne JS.
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
): Promise<Response> {
  const session = await getSession();
  if (!session) return seeOther("/login");

  const back = `/campaigns/${params.id}`;
  if (!canEdit(session)) return backWithError(back, "Keine Berechtigung.");

  const form = await req.formData();
  const action = String(form.get("action") ?? "");

  try {
    switch (action) {
      case "plan": {
        const res = await planCampaign(params.id, { reshuffle: form.get("reshuffle") === "1" });
        await audit({
          action: "campaign.plan",
          entity: "Campaign",
          entityId: params.id,
          detail: `${res.recipientCount} Empfänger`,
          userId: session.uid,
        });
        return backWithOk(
          back,
          `${res.recipientCount} Mails neu eingeplant. Die Kampagne ist geplant, aber noch nicht gestartet.`
        );
      }

      case "launch": {
        const res = await launchCampaign(params.id);
        await audit({
          action: "campaign.launch",
          entity: "Campaign",
          entityId: params.id,
          userId: session.uid,
        });
        return backWithOk(back, `Versand gestartet — ${res.recipientCount} Mails in der Warteschlange.`);
      }

      case "pause": {
        await pauseCampaign(params.id);
        await audit({
          action: "campaign.pause",
          entity: "Campaign",
          entityId: params.id,
          userId: session.uid,
        });
        return backWithOk(back, "Versand pausiert. Bereits gesendete Mails bleiben unberührt.");
      }

      case "resume": {
        const res = await resumeCampaign(params.id);
        await audit({
          action: "campaign.resume",
          entity: "Campaign",
          entityId: params.id,
          userId: session.uid,
        });
        return backWithOk(
          back,
          res.shifted > 0
            ? `Versand fortgesetzt. ${res.shifted} verpasste Termine wurden nach hinten verschoben, damit die Abstände erhalten bleiben.`
            : "Versand fortgesetzt."
        );
      }

      case "cancel": {
        const res = await cancelCampaign(params.id);
        await audit({
          action: "campaign.cancel",
          entity: "Campaign",
          entityId: params.id,
          userId: session.uid,
        });
        return backWithOk(back, `Kampagne abgebrochen — ${res.cancelled} ausstehende Mails verworfen.`);
      }

      default:
        return backWithError(back, "Unbekannte Aktion.");
    }
  } catch (e) {
    return backWithError(back, errorMessage(e));
  }
}
