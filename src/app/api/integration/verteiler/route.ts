import { NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { runSync, syncEnabled, syncSchema, tokenOk } from "@/lib/verteilerSync";

// Schnittstelle für den E-Mail-Verteiler (siehe src/lib/verteilerSync.ts).
//
// Absicherung über VERTEILER_SYNC_TOKEN als Bearer-Token (nur im Header, nie
// als URL-Parameter, damit es nicht in Logs landet). Ohne gesetztes Token ist
// der Endpunkt deaktiviert.

export const dynamic = "force-dynamic";

const MAX_BYTES = 30 * 1024 * 1024;

export async function POST(req: Request): Promise<Response> {
  if (!syncEnabled()) {
    return jsonError("VERTEILER_SYNC_TOKEN ist nicht gesetzt - die Schnittstelle ist deaktiviert.", 503);
  }
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  if (!tokenOk(provided)) return jsonError("Nicht autorisiert", 401);

  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return jsonError("Anfrage zu groß", 413);

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonError("Anfrage konnte nicht gelesen werden", 400);
  }
  if (raw.length > MAX_BYTES) return jsonError("Anfrage zu groß", 413);

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return jsonError("Ungültiges JSON", 400);
  }
  const parsed = syncSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return jsonError(`Ungültige Daten: ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim(), 400);
  }

  try {
    return NextResponse.json(await runSync(parsed.data));
  } catch (e) {
    console.error("[verteiler-sync]", e);
    return jsonError("Abgleich fehlgeschlagen", 500);
  }
}
