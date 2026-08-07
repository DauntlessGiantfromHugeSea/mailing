import type { SessionPayload } from "./session";

export function isAdmin(s: SessionPayload | null): boolean {
  return s?.role === "ADMIN";
}

/** Darf Kampagnen/Kontakte/Absender anlegen und starten. */
export function canEdit(s: SessionPayload | null): boolean {
  return s?.role === "ADMIN" || s?.role === "EDITOR";
}

export function roleLabel(role: string): string {
  switch (role) {
    case "ADMIN":
      return "Administrator";
    case "EDITOR":
      return "Bearbeiten";
    case "VIEWER":
      return "Nur lesen";
    default:
      return role;
  }
}
