import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { Db } from "@/db";
import { getPlayer } from "@/lib/domain/players";
import type { Player } from "@/db/schema";

export const PLAYER_COOKIE = "km_player";
const ONE_YEAR = 60 * 60 * 24 * 365;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production" && process.env.VERCEL) {
    throw new Error("SESSION_SECRET must be set in production");
  }
  return "dev-only-insecure-session-secret";
}

function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

export function sealPlayerId(playerId: string): string {
  return `${playerId}.${sign(playerId)}`;
}

export function unsealPlayerId(token: string | undefined | null): string | null {
  if (!token) return null;
  const idx = token.lastIndexOf(".");
  if (idx <= 0) return null;
  const id = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = sign(id);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return id;
}

export async function getSessionPlayerId(): Promise<string | null> {
  const store = await cookies();
  return unsealPlayerId(store.get(PLAYER_COOKIE)?.value);
}

export async function getSessionPlayer(db: Db): Promise<Player | null> {
  const id = await getSessionPlayerId();
  if (!id) return null;
  return getPlayer(db, id);
}

export async function setSessionPlayer(playerId: string): Promise<void> {
  const store = await cookies();
  store.set(PLAYER_COOKIE, sealPlayerId(playerId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR,
  });
}

export async function clearSessionPlayer(): Promise<void> {
  const store = await cookies();
  store.delete(PLAYER_COOKIE);
}

/** Per-event organizer access granted by visiting /{code}/manage/{manageCode}. */
export const manageCookieName = (code: string) => `km_manage_${code}`;

export async function grantManageAccess(code: string, manageCode: string): Promise<void> {
  const store = await cookies();
  store.set(manageCookieName(code), sign(`${code}:${manageCode}`), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: `/${code}`,
    maxAge: ONE_YEAR,
  });
}

export async function hasManageAccess(code: string, manageCode: string): Promise<boolean> {
  const store = await cookies();
  const v = store.get(manageCookieName(code))?.value;
  if (!v) return false;
  const expected = sign(`${code}:${manageCode}`);
  if (v.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(v), Buffer.from(expected));
  } catch {
    return false;
  }
}
