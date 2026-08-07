import { prisma } from "./db";

export async function audit(entry: {
  action: string;
  entity?: string;
  entityId?: string;
  detail?: string;
  userId?: string | null;
}): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        entity: entry.entity ?? null,
        entityId: entry.entityId ?? null,
        detail: entry.detail ?? null,
        userId: entry.userId ?? null,
      },
    });
  } catch (e) {
    // Ein fehlgeschlagener Audit-Eintrag darf die Aktion nicht abbrechen.
    console.error("[audit]", e);
  }
}
