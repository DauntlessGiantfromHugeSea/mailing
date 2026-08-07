import { NextResponse } from "next/server";

/** Relativer 303-Redirect - host-unabhaengig, korrekt hinter Reverse-Proxy. */
export function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export function backWithOk(path: string, message: string): NextResponse {
  return seeOther(`${path}${path.includes("?") ? "&" : "?"}ok=${encodeURIComponent(message)}`);
}

export function backWithError(path: string, message: string): NextResponse {
  return seeOther(`${path}${path.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
}

export function jsonError(message: string, status = 400): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
