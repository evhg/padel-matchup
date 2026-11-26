import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, tiktokKeys } from "@/lib/config";
import { matchReelByCode } from "@/lib/domain/matchReel";
import { authorizeUrl } from "@/lib/domain/tiktok";
import { redirectUri } from "@/lib/tiktok/api";
import { codeChallenge, cookieOptions, newState, openToken, STATE_COOKIE, STATE_PATH, STATE_TTL_MS, TOKEN_COOKIE } from "@/lib/tiktok/seal";

export const dynamic = "force-dynamic";

/**
 * "Share to TikTok" starts here: `GET /api/tiktok/start?code=<match code>`.
 *
 * The match must have a reel that plays. A browser that holds a TikTok token with five minutes or more
 * left goes straight to the posting page; any other (or `again=1`, "Use another account") gets a fresh
 * state cookie and goes to TikTok's own sign-in. Nothing is read from TikTok here.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  if (!isValidShareCode(code)) return NextResponse.redirect(`${baseUrl()}/`, 302);
  const reelPage = `${baseUrl()}/${code}/reel`;
  const keys = tiktokKeys();
  if (!keys) return NextResponse.redirect(reelPage, 302);
  const db = await getDb();
  const now = new Date();
  if (!(await matchReelByCode(db, code, now).catch(() => null))) return NextResponse.redirect(`${baseUrl()}/${code}`, 302);
  const again = url.searchParams.get("again") === "1";
  if (!again && openToken(req.cookies.get(TOKEN_COOKIE)?.value, now, 5 * 60_000)) return NextResponse.redirect(`${reelPage}/tiktok`, 302);
  const state = newState(code, now);
  const res = NextResponse.redirect(authorizeUrl({ clientKey: keys.clientKey, redirectUri: redirectUri(), state: state.nonce, codeChallenge: codeChallenge(state.verifier) }), 302);
  res.cookies.set(STATE_COOKIE, state.cookie, cookieOptions(STATE_TTL_MS / 1000, STATE_PATH));
  if (again) res.cookies.set(TOKEN_COOKIE, "", cookieOptions(0));
  res.headers.set("cache-control", "no-store");
  return res;
}
