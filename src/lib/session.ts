import { cookies } from "next/headers";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import type { Role } from "@prisma/client";

const COOKIE = "ml_session";
const MAX_AGE = 60 * 60 * 12; // 12h

function secret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET fehlt oder ist kürzer als 32 Zeichen.");
  return new TextEncoder().encode(s);
}

export interface SessionPayload extends JWTPayload {
  uid: string;
  role: Role;
  name: string;
  email: string;
}

export async function createSession(payload: Omit<SessionPayload, keyof JWTPayload>): Promise<void> {
  const token = await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + MAX_AGE)
    .sign(secret());

  cookies().set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE,
  });
}

export async function getSession(): Promise<SessionPayload | null> {
  const token = cookies().get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as SessionPayload;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  cookies().set(COOKIE, "", { path: "/", maxAge: 0 });
}

export const SESSION_COOKIE = COOKIE;
