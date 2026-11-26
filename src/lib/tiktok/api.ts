import "server-only";
import { baseUrl, tiktokKeys } from "@/lib/config";
import { creatorOf, initBody, publishIdOf, statusOf, TIKTOK_API, tokenOf, type Creator, type PostForm, type PostStatus, type TikTokError, type TikTokToken } from "@/lib/domain/tiktok";

/**
 * The four calls to TikTok, server side only (the client secret and the token never reach a browser).
 * Each takes a `fetchImpl`, so the tests answer for TikTok. A network fault or an answer that is not
 * JSON comes back as a refusal of our own (`network`), never as a throw.
 */

type Fetch = typeof fetch;
type Result<T> = { ok: true } & T;
type Refused = { ok: false; error: TikTokError };

/** The one redirect address TikTok holds for the app: it must match exactly, here and in the developer portal. */
export const redirectUri = () => `${baseUrl()}/api/tiktok/callback`;

async function call(fetchImpl: Fetch, url: string, init: RequestInit): Promise<{ ok: true; json: unknown } | Refused> {
  try {
    const res = await fetchImpl(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const json = await res.json().catch(() => null);
    if (json === null) return { ok: false, error: { code: "network", message: `HTTP ${res.status}` } };
    return { ok: true, json };
  } catch (e) {
    return { ok: false, error: { code: "network", message: (e as Error)?.name ?? "" } };
  }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json; charset=UTF-8" });

/** The code of TikTok's callback, for a token. */
export async function exchangeCode(code: string, now: Date, fetchImpl: Fetch = fetch): Promise<Result<{ token: TikTokToken }> | Refused> {
  const keys = tiktokKeys();
  if (!keys) return { ok: false, error: { code: "off", message: "" } };
  const body = new URLSearchParams({ client_key: keys.clientKey, client_secret: keys.clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri() });
  const got = await call(fetchImpl, `${TIKTOK_API}/v2/oauth/token/`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!got.ok) return got;
  const t = tokenOf(got.json, now);
  return t.ok ? { ok: true, token: t.token } : t;
}

/** The creator's account as it is now: who posts, and what the account allows. TikTok allows 20 a minute for one token. */
export async function creatorInfo(accessToken: string, fetchImpl: Fetch = fetch): Promise<Result<{ creator: Creator }> | Refused> {
  const got = await call(fetchImpl, `${TIKTOK_API}/v2/post/publish/creator_info/query/`, { method: "POST", headers: bearer(accessToken) });
  if (!got.ok) return got;
  const c = creatorOf(got.json);
  return c.ok ? { ok: true, creator: c.creator } : c;
}

/** Direct Post: TikTok pulls the reel from `videoUrl` and posts it. TikTok allows 6 a minute for one token. */
export async function initPost(accessToken: string, creator: Creator, form: PostForm, videoUrl: string, fetchImpl: Fetch = fetch): Promise<Result<{ publishId: string }> | Refused> {
  const got = await call(fetchImpl, `${TIKTOK_API}/v2/post/publish/video/init/`, { method: "POST", headers: bearer(accessToken), body: JSON.stringify(initBody(creator, form, videoUrl)) });
  if (!got.ok) return got;
  const p = publishIdOf(got.json);
  return p.ok ? { ok: true, publishId: p.publishId } : p;
}

/** Where a post stands. TikTok allows 30 a minute for one token. */
export async function postStatus(accessToken: string, publishId: string, fetchImpl: Fetch = fetch): Promise<Result<{ status: PostStatus }> | Refused> {
  const got = await call(fetchImpl, `${TIKTOK_API}/v2/post/publish/status/fetch/`, { method: "POST", headers: bearer(accessToken), body: JSON.stringify({ publish_id: publishId }) });
  if (!got.ok) return got;
  const s = statusOf(got.json);
  return s.ok ? { ok: true, status: s.status } : s;
}
