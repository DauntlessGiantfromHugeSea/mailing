import { tick, nextDueAt } from "../src/lib/worker";
import { prisma } from "../src/lib/db";

// Standalone-Worker. Laeuft neben `next start` (siehe docker-compose.yml).
//
// Der Loop schlaeft adaptiv: liegt der naechste Job weit in der Zukunft, wird
// laenger gewartet. So kostet ein 3-Minuten-Takt nicht 3 Minuten Dauerpolling.
//
// Alternativ zum Worker gibt es /api/cron/tick fuer externe Cron/Serverless -
// beide benutzen dasselbe tick() und dasselbe DB-Lock.

const MIN_SLEEP_MS = 5_000;
const MAX_SLEEP_MS = 60_000;
const HOLDER = `worker-${process.pid}`;

let running = true;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string): void {
  console.log(`[worker ${new Date().toISOString()}] ${msg}`);
}

async function nextSleepMs(): Promise<number> {
  const due = await nextDueAt();
  if (!due) return MAX_SLEEP_MS;
  const deltaMs = due.getTime() - Date.now();
  if (deltaMs <= 0) return MIN_SLEEP_MS;
  // Kurz vor dem Termin aufwachen, damit die Mail puenktlich rausgeht.
  return Math.min(MAX_SLEEP_MS, Math.max(MIN_SLEEP_MS, deltaMs - 1_000));
}

async function main(): Promise<void> {
  log("gestartet");

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      log(`${sig} empfangen - beende nach dem aktuellen Tick`);
      running = false;
    });
  }

  while (running) {
    try {
      const res = await tick({ holder: HOLDER });
      if (res.processed > 0 || res.notes.length > 0) {
        log(
          `verarbeitet=${res.processed} gesendet=${res.sent} fehler=${res.failed} ` +
            `übersprungen=${res.skipped} verschoben=${res.deferred}` +
            (res.notes.length ? ` | ${res.notes.join(" | ")}` : "")
        );
      }
    } catch (e) {
      log(`Tick-Fehler: ${e instanceof Error ? e.message : String(e)}`);
    }

    const ms = await nextSleepMs().catch(() => MAX_SLEEP_MS);
    for (let waited = 0; waited < ms && running; waited += 1_000) {
      await sleep(Math.min(1_000, ms - waited));
    }
  }

  await prisma.$disconnect();
  log("beendet");
}

main().catch(async (e) => {
  console.error("[worker] Abbruch:", e);
  await prisma.$disconnect();
  process.exit(1);
});
