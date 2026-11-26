import { NextResponse, type NextRequest } from "next/server";
import { baseUrl, tiktokKeys } from "@/lib/config";
import { POST_SCOPE, type CallbackWhy } from "@/lib/domain/tiktok";
import { exchangeCode } from "@/lib/tiktok/api";
import { checkState, cookieOptions, sealToken, STATE_COOKIE, STATE_PATH, TOKEN_COOKIE } from "@/lib/tiktok/seal";

export const dynamic = "force-dynamic";

/**
 * TikTok sends the player back here: `GET /api/tiktok/callback?code&scopes&state`, or `?error&error_description`.
 * The registered redirect URI is exactly this address on https://kicksma.sh.
 *
 * The state must be the nonce of the sealed cookie that `/api/tiktok/start` set, within its ten minutes; the
 * cookie also holds the PKCE verifier, which goes with the code.
 * Then the code goes for a token (server side, with the client secret), the token goes into its
 * encrypted cookie, and the player lands on the posting page. Any failure goes back to the reel page
 * with `?tiktok=<why>`; a cookie that is not ours at all goes to the home page.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const now = new Date();
  const state = checkState(req.cookies.get(STATE_COOKIE)?.value, url.searchParams.get("state"), now);
  const back = (why: CallbackWhy) => {
    const res = NextResponse.redirect(state.code ? `${baseUrl()}/${state.code}/reel?tiktok=${why}` : `${baseUrl()}/`, 303);
    res.cookies.set(STATE_COOKIE, "", cookieOptions(0, STATE_PATH));
    return res;
  };
  if (!tiktokKeys() || !state.code) return back("failed");
  if (!state.ok || !state.verifier) return back("expired");
  if (url.searchParams.get("error")) return back("denied");
  const code = url.searchParams.get("code");
  if (!code || code.length > 1000) return back("failed");
  const got = await exchangeCode(code, state.verifier, now);
  if (!got.ok) return back("failed");
  if (!got.token.scopes.includes(POST_SCOPE)) return back("scope");
  const res = NextResponse.redirect(`${baseUrl()}/${state.code}/reel/tiktok`, 303);
  res.cookies.set(STATE_COOKIE, "", cookieOptions(0, STATE_PATH));
  res.cookies.set(TOKEN_COOKIE, sealToken(got.token), cookieOptions((got.token.expiresAt - now.getTime()) / 1000));
  res.headers.set("cache-control", "no-store");
  return res;
}
