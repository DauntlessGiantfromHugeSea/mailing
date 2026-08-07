import { NextResponse } from "next/server";
import { tick } from "@/lib/worker";
import { jsonError } from "@/lib/http";

// Alternative zum Worker-Prozess: ein externer Cron ruft diesen Endpunkt
// regelmaessig auf (z.B. jede Minute). Beide Wege benutzen dasselbe tick() und
// dasselbe DB-Lock, ein Parallelbetrieb ist also unschaedlich.
//
// Absicherung ueber CRON_SECRET, entweder als Bearer-Token oder ?secret=.
// Ohne gesetztes CRON_SECRET ist der Endpunkt deaktiviert - ein offener
// Sende-Trigger waere sonst von aussen missbrauchbar.

export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return jsonError(
      "CRON_SECRET ist nicht gesetzt - der Cron-Endpunkt ist deaktiviert. Nutze stattdessen den Worker (npm run worker).",
      503
    );
  }

  const url = new URL(req.url);
  const provided =
    req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("secret") ?? "";
  if (provided !== expected) return jsonError("Nicht autorisiert", 401);

  const maxPerTick = Number(url.searchParams.get("max") ?? 5);
  const res = await tick({
    maxPerTick: Number.isFinite(maxPerTick) ? Math.min(50, Math.max(1, maxPerTick)) : 5,
    holder: "cron",
  });

  return NextResponse.json(res);
}

export const GET = handle;
export const POST = handle;
