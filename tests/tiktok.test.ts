import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { NextRequest } from "next/server";
import { getDb } from "@/db";
import { GET as start } from "@/app/api/tiktok/start/route";
import { GET as callback } from "@/app/api/tiktok/callback/route";
import { POST as post } from "@/app/api/tiktok/post/route";
import { POST as status } from "@/app/api/tiktok/status/route";
import { GET as video, HEAD as videoHead } from "@/app/api/tiktok/video/[file]/route";
import { TikTokPost } from "@/components/TikTokPost";
import { tiktokShareOn } from "@/lib/config";
import { setMatchReel } from "@/lib/domain/matchReel";
import { recordPlayedMatch } from "@/lib/domain/playedMatch";
import {
  authorizeUrl,
  isCodeVerifier,
  commercialLabel,
  creatorOf,
  formRules,
  initBody,
  initialForm,
  notAllowedYet,
  notReady,
  POST_SCOPE,
  readPostForm,
  shareFileOf,
  shareSwitchOn,
  statusOf,
  TIKTOK_SCOPES,
  tokenOf,
  type Creator,
  type PostForm,
} from "@/lib/domain/tiktok";
import { SHARE_CHECK_MS, shareFileThere } from "@/lib/tiktok/shareFile";
import { checkState, codeChallenge, newCodeVerifier, newState, openToken, sealToken, STATE_COOKIE, STATE_TTL_MS, TICKET_TTL_MS, TOKEN_COOKIE, videoTicket, videoTicketOk } from "@/lib/tiktok/seal";
import { freezeClock } from "./helpers/clock";
import { DAY } from "./helpers/db";
import { renderIn } from "./helpers/render";

/**
 * "Share to TikTok" (the owner, 26 November 2026). Every call to TikTok goes through a fake fetch: no test
 * reaches TikTok or the reel host. The rules of the posting page come from TikTok's Content Sharing Guidelines.
 */
const NOW = new Date("2026-11-26T05:00:00Z");
freezeClock(NOW);

const REEL_HOST = "https://reels.example.test";
const REEL_TOKEN = "tiktok_reel_token_of_32_characters";
const TIKTOK = "https://open.tiktokapis.com";

const PUBLIC: Creator = {
  avatarUrl: "https://p16.tiktokcdn.example/a.jpg",
  username: "kicksma.sh",
  nickname: "Kicksmash",
  privacyOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxDurationSec: 600,
};
const PRIVATE_ACCOUNT: Creator = { ...PUBLIC, privacyOptions: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"], duetDisabled: true, stitchDisabled: true };
const creatorJson = (c: Creator) => ({
  data: {
    creator_avatar_url: c.avatarUrl,
    creator_username: c.username,
    creator_nickname: c.nickname,
    privacy_level_options: c.privacyOptions,
    comment_disabled: c.commentDisabled,
    duet_disabled: c.duetDisabled,
    stitch_disabled: c.stitchDisabled,
    max_video_post_duration_sec: c.maxDurationSec,
  },
  error: { code: "ok", message: "", log_id: "x" },
});

type Call = { url: string; init: RequestInit };
/** A fake fetch that answers by address and keeps every call. */
function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    return answer(url, init);
  });
  return calls;
}
const json = (body: unknown, s = 200) => new Response(JSON.stringify(body), { status: s, headers: { "content-type": "application/json" } });
const headerOf = (init: RequestInit, name: string) => new Headers(init.headers).get(name);
const SHARE_URL = `${REEL_HOST}/r/${REEL_TOKEN}/share.mp4`;
/** The reel host's answer to the HEAD for the reel's public version (`share.mp4`), before `answer` for anything else. */
const withShare =
  (answer: (url: string, init: RequestInit) => Response | Promise<Response>, share: number = 200) =>
  (url: string, init: RequestInit) =>
    url === SHARE_URL && init.method === "HEAD" ? new Response(null, { status: share }) : answer(url, init);
const isTikTok = (c: Call) => c.url.startsWith(TIKTOK);

const token = (over: Partial<{ accessToken: string; scopes: string[]; expiresAt: number }> = {}) =>
  sealToken({ accessToken: "act.player-token", openId: "open-1", scopes: ["user.info.basic", "video.publish"], expiresAt: NOW.getTime() + 2 * 3600_000, ...over });
const withCookies = (url: string, cookies: Record<string, string>, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  new NextRequest(url, {
    method: init.method ?? "GET",
    headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; "), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });

let code = "";
beforeAll(async () => {
  const db = await getDb();
  ({ code } = await recordPlayedMatch(db, { startsAt: new Date(NOW.getTime() - 2 * DAY), tz: "Asia/Bangkok", venueName: "TikTok Club", teamA: ["Ana", "Bo"], teamB: ["Cy", "Di"], sets: [{ sideA: 6, sideB: 3 }, { sideA: 6, sideB: 4 }], now: NOW }));
  await setMatchReel(db, { code, host: REEL_HOST, token: REEL_TOKEN, now: NOW });
});
const keysOn = () => {
  process.env.TIKTOK_CLIENT_KEY = "test-client-key";
  process.env.TIKTOK_CLIENT_SECRET = "test-client-secret";
  process.env.APP_BASE_URL = "https://kicksma.sh";
  // The reel host holds share.mp4 unless a test says otherwise; any other call is refused, so nothing leaves.
  fakeFetch(withShare((url) => Promise.reject(new Error(`no fetch expected: ${url}`))));
};
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the sign-in's state", () => {
  it("opens only for its own nonce, within its ten minutes, under our key, and gives back its verifier", () => {
    const s = newState("ABCD", NOW);
    expect(checkState(s.cookie, s.nonce, NOW)).toEqual({ ok: true, code: "ABCD", verifier: s.verifier });
    expect(checkState(s.cookie, s.nonce, new Date(NOW.getTime() + STATE_TTL_MS - 1)).ok).toBe(true);
    expect(checkState(s.cookie, s.nonce, new Date(NOW.getTime() + STATE_TTL_MS))).toEqual({ ok: false, code: "ABCD", why: "expired" });
    expect(checkState(s.cookie, "another-nonce", NOW)).toEqual({ ok: false, code: "ABCD", why: "mismatch" });
    expect(checkState(s.cookie, null, NOW).ok).toBe(false);
    // Sealed, so neither the nonce nor the verifier can be read in the cookie; a sealed value changed in its first
    // character, and a token cookie (another purpose's key) offered as the state, are not ours.
    expect(s.cookie).not.toContain(s.verifier);
    expect(s.cookie).not.toContain(s.nonce);
    const [v, iv, body] = s.cookie.split(".");
    expect(checkState([v, iv, (body[0] === "A" ? "B" : "A") + body.slice(1)].join("."), s.nonce, NOW)).toEqual({ ok: false, code: null, why: "missing" });
    expect(checkState(["s2", ...token().split(".").slice(1)].join("."), s.nonce, NOW)).toEqual({ ok: false, code: null, why: "missing" });
    expect(checkState(undefined, s.nonce, NOW)).toEqual({ ok: false, code: null, why: "missing" });
  });

  it("makes the PKCE challenge as TikTok's page states it: the hex SHA-256 of the verifier, method S256", () => {
    // RFC 7636's example verifier. Its base64url challenge would be "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    // TikTok asks for the same SHA-256 in hex (developers.tiktok.com/doc/login-kit-desktop).
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(codeChallenge(verifier)).toBe("13d31e961a1ad8ec2f16b10c4c982e0876a878ad6df144566ee1894acb70f9c3");
    expect(Buffer.from(codeChallenge(verifier), "hex").toString("base64url")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    const url = new URL(authorizeUrl({ clientKey: "k", redirectUri: "https://kicksma.sh/api/tiktok/callback", state: "s", codeChallenge: codeChallenge(verifier) }));
    expect([url.searchParams.get("code_challenge"), url.searchParams.get("code_challenge_method")]).toEqual(["13d31e961a1ad8ec2f16b10c4c982e0876a878ad6df144566ee1894acb70f9c3", "S256"]);
    // A fresh verifier each time, within TikTok's characters and its 43 to 128.
    const a = newCodeVerifier();
    expect(isCodeVerifier(a) && a !== newCodeVerifier() && a.length === 64).toBe(true);
    for (const bad of ["short", "a".repeat(129), `${"a".repeat(43)}/`, null]) expect(isCodeVerifier(bad), String(bad)).toBe(false);
  });

  it("asks for Login Kit and Direct Post only: user.info.basic and video.publish, never video.upload", () => {
    // TikTok's app review: every scope asked for must show in the review video, and the app shows no inbox upload.
    expect([...TIKTOK_SCOPES]).toEqual(["user.info.basic", "video.publish"]);
    expect(POST_SCOPE).toBe("video.publish");
    const url = new URL(authorizeUrl({ clientKey: "k", redirectUri: "https://kicksma.sh/api/tiktok/callback", state: "s", codeChallenge: "c" }));
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.publish");
    expect(url.toString()).not.toContain("video.upload");
  });

  it("starts at TikTok's own sign-in with the two scopes, the exact redirect address, the nonce and the challenge", async () => {
    keysOn();
    const res = await start(withCookies(`https://kicksma.sh/api/tiktok/start?code=${code}`, {}));
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get("location")!);
    expect(`${to.origin}${to.pathname}`).toBe("https://www.tiktok.com/v2/auth/authorize/");
    expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_key: "test-client-key", response_type: "code", scope: "user.info.basic,video.publish", redirect_uri: "https://kicksma.sh/api/tiktok/callback" });
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Path=\/api\/tiktok/);
    expect(set).toMatch(/Max-Age=600/);
    const opened = checkState(decodeURIComponent(set.split(";")[0].slice(STATE_COOKIE.length + 1)), to.searchParams.get("state"), NOW);
    expect(opened.ok).toBe(true);
    // The address carries the challenge of the verifier the cookie keeps, never the verifier itself.
    expect(to.searchParams.get("code_challenge")).toBe(codeChallenge(opened.verifier!));
    expect(to.searchParams.get("code_challenge_method")).toBe("S256");
    expect(to.toString()).not.toContain(opened.verifier!);
  });

  it("shows the button only with TIKTOK_SHARE on and both values set, while the routes answer without the switch", async () => {
    keysOn();
    delete process.env.TIKTOK_SHARE;
    expect(tiktokShareOn(code)).toBe(false);
    // The start answers with the keys alone (keysOn sets no switch): a test user in the sandbox can still use the routes.
    expect((await start(withCookies(`https://kicksma.sh/api/tiktok/start?code=${code}`, {}))).headers.get("location")).toMatch(/^https:\/\/www\.tiktok\.com\//);
    for (const v of ["off", "1", "true", ""]) {
      process.env.TIKTOK_SHARE = v;
      expect(tiktokShareOn(code), v).toBe(false);
    }
    process.env.TIKTOK_SHARE = " On ";
    expect([tiktokShareOn(code), tiktokShareOn("WXYZ"), tiktokShareOn(null)]).toEqual([true, true, true]);
    delete process.env.TIKTOK_CLIENT_SECRET;
    expect(tiktokShareOn(code)).toBe(false);
  });

  it("takes a list of match codes too: the button shows on those matches only, so TikTok's reviewer sees a demo match", () => {
    keysOn();
    process.env.TIKTOK_SHARE = `ZeTn, ${code} ,YgFK`;
    expect([tiktokShareOn(code), tiktokShareOn("ZeTn"), tiktokShareOn("YgFK")]).toEqual([true, true, true]);
    // Any other match, a page about no match, and the same letters in another case: no button.
    expect([tiktokShareOn("WXYZ"), tiktokShareOn(null), tiktokShareOn("zetn")]).toEqual([false, false, false]);
    delete process.env.TIKTOK_CLIENT_KEY;
    expect(tiktokShareOn(code)).toBe(false);
    // The rule itself: `on` in any case for every match; a list only for its own codes; a piece that is no code is skipped.
    expect(shareSwitchOn("ON", "WXYZ")).toBe(true);
    expect(shareSwitchOn("on", null)).toBe(true);
    expect(shareSwitchOn("ZeTn", "ZeTn")).toBe(true);
    expect(shareSwitchOn("ZeTn,,", "ZeTn")).toBe(true);
    expect(shareSwitchOn("ZeTn", null)).toBe(false);
    expect(shareSwitchOn("on,ZeTn", "WXYZ")).toBe(false);
    expect(shareSwitchOn("ZeTnX,ZeT", "ZeTn")).toBe(false);
    expect(shareSwitchOn(undefined, "ZeTn")).toBe(false);
    expect(shareSwitchOn("", "ZeTn")).toBe(false);
  });

  it("never sends a reel with no public version to TikTok's sign-in: the posting page says to make it again", async () => {
    keysOn();
    let calls = fakeFetch(withShare(() => Promise.reject(new Error("no other call")), 404));
    const old = await start(withCookies(`https://kicksma.sh/api/tiktok/start?code=${code}`, {}));
    expect(old.headers.get("location")).toBe(`https://kicksma.sh/${code}/reel/tiktok`);
    expect(old.headers.getSetCookie().some((c) => c.startsWith(`${STATE_COOKIE}=`))).toBe(false);
    expect(calls.map((c) => [c.url, c.init.method])).toEqual([[SHARE_URL, "HEAD"]]);
    // A reel host that does not answer now stops nothing here: the posting page asks again and says to try later.
    calls = fakeFetch(withShare(() => Promise.reject(new Error("no other call")), 503));
    expect((await start(withCookies(`https://kicksma.sh/api/tiktok/start?code=${code}`, {}))).headers.get("location")).toMatch(/^https:\/\/www\.tiktok\.com\//);
  });

  it("skips TikTok for a browser that holds a fresh token, refuses a match with no reel, and is off without the keys", async () => {
    keysOn();
    const again = await start(withCookies(`https://kicksma.sh/api/tiktok/start?code=${code}`, { [TOKEN_COOKIE]: token() }));
    expect(again.headers.get("location")).toBe(`https://kicksma.sh/${code}/reel/tiktok`);
    const other = await start(withCookies(`https://kicksma.sh/api/tiktok/start?code=${code}&again=1`, { [TOKEN_COOKIE]: token() }));
    expect(other.headers.get("location")).toMatch(/^https:\/\/www\.tiktok\.com\//);
    const none = await start(withCookies("https://kicksma.sh/api/tiktok/start?code=QQQQ", {}));
    expect(none.headers.get("location")).toBe("https://kicksma.sh/QQQQ");
    delete process.env.TIKTOK_CLIENT_SECRET;
    const off = await start(withCookies(`https://kicksma.sh/api/tiktok/start?code=${code}`, {}));
    expect(off.headers.get("location")).toBe(`https://kicksma.sh/${code}/reel`);
  });
});

describe("the token", () => {
  it("is exchanged for the code with the client secret and the PKCE verifier, server side, as a form", async () => {
    keysOn();
    const calls = fakeFetch(() => json({ access_token: "act.new", expires_in: 7200, open_id: "open-9", refresh_token: "rft.never-kept", scope: "user.info.basic,video.publish", token_type: "Bearer" }));
    const s = newState(code, NOW);
    const res = await callback(withCookies(`https://kicksma.sh/api/tiktok/callback?code=the-code&scopes=user.info.basic,video.publish&state=${s.nonce}`, { [STATE_COOKIE]: s.cookie }));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${TIKTOK}/v2/oauth/token/`);
    expect(headerOf(calls[0].init, "content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init.body)))).toEqual({ client_key: "test-client-key", client_secret: "test-client-secret", code: "the-code", grant_type: "authorization_code", redirect_uri: "https://kicksma.sh/api/tiktok/callback", code_verifier: s.verifier });
    expect(res.headers.get("location")).toBe(`https://kicksma.sh/${code}/reel/tiktok`);
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${TOKEN_COOKIE}=`))!;
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=lax/i);
    expect(set).toMatch(/Max-Age=7200/);
    const value = decodeURIComponent(set.split(";")[0].slice(TOKEN_COOKIE.length + 1));
    // Encrypted: neither the token nor the refresh token is readable in the cookie, and the refresh token is not kept at all.
    expect(value).not.toContain("act.new");
    expect(value).not.toContain("rft");
    expect(openToken(value, NOW)).toEqual({ accessToken: "act.new", openId: "open-9", scopes: ["user.info.basic", "video.publish"], expiresAt: NOW.getTime() + 7200_000 });
    // The state cookie is spent.
    expect(res.headers.getSetCookie().find((c) => c.startsWith(`${STATE_COOKIE}=`))).toMatch(/Max-Age=0/);
  });

  it("goes back to the reel page with a reason of its own for a bad state, a refusal, a failed exchange or a missing scope", async () => {
    keysOn();
    const s = newState(code, NOW);
    const back = async (query: string, answer?: () => Response) => {
      const calls = fakeFetch(answer ?? (() => json({ error: "invalid_grant", error_description: "Authorization code is expired." })));
      const res = await callback(withCookies(`https://kicksma.sh/api/tiktok/callback?${query}`, { [STATE_COOKIE]: s.cookie }));
      return { to: res.headers.get("location"), calls: calls.length, token: res.headers.getSetCookie().some((c) => c.startsWith(`${TOKEN_COOKIE}=`)) };
    };
    expect(await back("code=x&state=not-the-nonce")).toEqual({ to: `https://kicksma.sh/${code}/reel?tiktok=expired`, calls: 0, token: false });
    expect(await back(`error=server_error&error_description=${encodeURIComponent("<b>hi</b>")}&state=${s.nonce}`)).toEqual({ to: `https://kicksma.sh/${code}/reel?tiktok=denied`, calls: 0, token: false });
    // A sign-in TikTok refuses while the app is in test (an account it does not let in yet): one plain line, "test".
    expect(await back(`error=access_denied&error_description=${encodeURIComponent("<b>hi</b>")}&state=${s.nonce}`)).toEqual({ to: `https://kicksma.sh/${code}/reel?tiktok=test`, calls: 0, token: false });
    expect(await back(`code=x&state=${s.nonce}`, () => json({ error: "unauthorized_client", error_description: "Client is not authorized." }, 401))).toEqual({ to: `https://kicksma.sh/${code}/reel?tiktok=test`, calls: 1, token: false });
    expect(await back(`code=x&state=${s.nonce}`)).toEqual({ to: `https://kicksma.sh/${code}/reel?tiktok=failed`, calls: 1, token: false });
    expect(await back(`code=x&state=${s.nonce}`, () => json({ access_token: "act.x", expires_in: 7200, scope: "user.info.basic" }))).toEqual({ to: `https://kicksma.sh/${code}/reel?tiktok=scope`, calls: 1, token: false });
    const stranger = await callback(withCookies("https://kicksma.sh/api/tiktok/callback?code=x&state=y", {}));
    expect(stranger.headers.get("location")).toBe("https://kicksma.sh/");
  });

  it("opens only under our key, and not once it ran out", () => {
    const value = token({ expiresAt: NOW.getTime() + 60_000 });
    expect(openToken(value, NOW)?.accessToken).toBe("act.player-token");
    expect(openToken(value, NOW, 5 * 60_000)).toBeNull();
    expect(openToken(value, new Date(NOW.getTime() + 60_000))).toBeNull();
    const [v, iv, body] = value.split(".");
    expect(openToken([v, iv, (body[0] === "A" ? "B" : "A") + body.slice(1)].join("."), NOW)).toBeNull();
    expect(tokenOf({ error: "invalid_request", error_description: "Bad code" }, NOW)).toEqual({ ok: false, error: { code: "invalid_request", message: "Bad code" } });
  });
});

describe("the posting page's form, from the creator's account", () => {
  it("reads creator info, and a refusal of it as TikTok's own words", () => {
    expect(creatorOf(creatorJson(PRIVATE_ACCOUNT))).toEqual({ ok: true, creator: PRIVATE_ACCOUNT });
    expect(creatorOf({ data: {}, error: { code: "spam_risk_too_many_posts", message: "The daily post cap is reached." } })).toEqual({ ok: false, error: { code: "spam_risk_too_many_posts", message: "The daily post cap is reached." } });
  });

  it("starts with no privacy chosen, every interaction off and commercial content off", () => {
    const form = initialForm("Ana & Bo won 6-3 6-4");
    expect(form).toEqual({ title: "Ana & Bo won 6-3 6-4", privacy: "", allowComment: false, allowDuet: false, allowStitch: false, commercial: false, yourBrand: false, branded: false });
    expect(notReady(PUBLIC, form, 180)).toBe("privacy");
  });

  it("offers only the account's own privacy options, and locks what the account turns off", () => {
    const r = formRules(PRIVATE_ACCOUNT, initialForm("x"));
    expect(r.privacyOptions).toEqual(["FOLLOWER_OF_CREATOR", "SELF_ONLY"]);
    expect([r.comment.disabled, r.duet.disabled, r.stitch.disabled]).toEqual([false, true, true]);
    expect(notReady(PRIVATE_ACCOUNT, { ...initialForm("x"), privacy: "PUBLIC_TO_EVERYONE" }, 180)).toBe("privacy");
  });

  it("needs a choice under commercial content, and never lets branded content be private", () => {
    const base: PostForm = { ...initialForm("x"), privacy: "SELF_ONLY", commercial: true };
    expect(notReady(PUBLIC, base, 180)).toBe("commercial");
    expect(commercialLabel(base)).toBe("commercialPick");
    expect(formRules(PUBLIC, base).brandedDisabled).toBe(true);
    expect(notReady(PUBLIC, { ...base, branded: true }, 180)).toBe("branded_private");
    expect(notReady(PUBLIC, { ...base, yourBrand: true }, 180)).toBeNull();
    expect(commercialLabel({ ...base, yourBrand: true })).toBe("labelPromo");
    const branded = { ...base, privacy: "FOLLOWER_OF_CREATOR", branded: true };
    expect(formRules(PUBLIC, branded).privateDisabled).toBe(true);
    expect(commercialLabel(branded)).toBe("labelPaid");
    expect(notReady(PUBLIC, branded, 180)).toBeNull();
    expect(commercialLabel({ ...branded, commercial: false })).toBeNull();
  });

  it("refuses a reel longer than the account may post, and an empty title", () => {
    const form = { ...initialForm("x"), privacy: "SELF_ONLY" };
    expect(notReady({ ...PUBLIC, maxDurationSec: 180 }, form, 180.5)).toBe("too_long");
    expect(notReady({ ...PUBLIC, maxDurationSec: 180 }, form, 179.9)).toBeNull();
    expect(notReady(PUBLIC, { ...form, title: "" }, 30)).toBe("title");
  });

  it("renders the creator, the preview, no privacy picked, three switches off and two locked, and the legal line", () => {
    const html = renderIn("en", createElement(TikTokPost, { code: "ABCD", creator: PRIVATE_ACCOUNT, video: `${REEL_HOST}/r/t/share.mp4`, poster: `${REEL_HOST}/r/t/poster.jpg`, title: "Ana & Bo won" }));
    expect(html).toContain("Kicksmash");
    expect(html).toContain("@kicksma.sh");
    expect(html).toContain('data-testid="tiktok-preview"');
    expect(html).toMatch(/<option value="" disabled="" selected="">Choose<\/option>/);
    expect(html).not.toContain("Everyone");
    expect(html).toContain(">Followers<");
    expect(html).toContain(">Only me<");
    expect(html.match(/role="switch" aria-checked="false"/g)).toHaveLength(4);
    expect(html).toMatch(/aria-label="Duet" disabled=""/);
    expect(html).toMatch(/aria-label="Stitch" disabled=""/);
    expect(html).not.toMatch(/aria-label="Comment" disabled=""/);
    expect(html).toContain("https://www.tiktok.com/legal/page/global/music-usage-confirmation/en");
    expect(html).toMatch(/<button[^>]* disabled=""[^>]*data-testid="tiktok-post"/);
  });
});

describe("Post", () => {
  const form = { code: "", title: "Ana & Bo won 6-3 6-4", privacy: "SELF_ONLY", allowComment: true, allowDuet: true, allowStitch: false, commercial: false, yourBrand: false, branded: false, durationSec: 182 };

  it("reads the account again, then asks for a Direct Post that TikTok pulls from our own address with a ticket", async () => {
    keysOn();
    const all = fakeFetch(withShare((url) => (url.endsWith("/creator_info/query/") ? json(creatorJson(PRIVATE_ACCOUNT)) : json({ data: { publish_id: "v_pub_url~v2.123" }, error: { code: "ok", message: "" } }))));
    const res = await post(withCookies("https://kicksma.sh/api/tiktok/post", { [TOKEN_COOKIE]: token() }, { method: "POST", body: { ...form, code }, headers: { origin: "https://kicksma.sh" } }));
    expect(await res.json()).toEqual({ ok: true, publishId: "v_pub_url~v2.123" });
    // First the reel host's HEAD for share.mp4 (no token goes there), then TikTok.
    expect(all.map((c) => c.url)).toEqual([SHARE_URL, `${TIKTOK}/v2/post/publish/creator_info/query/`, `${TIKTOK}/v2/post/publish/video/init/`]);
    expect(headerOf(all[0].init, "authorization")).toBeNull();
    const calls = all.filter(isTikTok);
    for (const c of calls) {
      expect(headerOf(c.init, "authorization")).toBe("Bearer act.player-token");
      expect(headerOf(c.init, "content-type")).toBe("application/json; charset=UTF-8");
    }
    const body = JSON.parse(String(calls[1].init.body));
    // Duet is off in the account's settings, so it goes disabled although the form allowed it; the file is the reel as it is.
    expect(body.post_info).toEqual({ title: "Ana & Bo won 6-3 6-4", privacy_level: "SELF_ONLY", disable_comment: false, disable_duet: true, disable_stitch: true, video_cover_timestamp_ms: 1000, brand_content_toggle: false, brand_organic_toggle: false });
    expect(body.source_info.source).toBe("PULL_FROM_URL");
    const pulled = new URL(body.source_info.video_url);
    expect(`${pulled.origin}${pulled.pathname}`).toBe(`https://kicksma.sh/api/tiktok/video/${code}.mp4`);
    expect(videoTicketOk(code, pulled.searchParams.get("t"), new Date(NOW.getTime() + TICKET_TTL_MS - 1))).toBe(true);
    expect(videoTicketOk(code, pulled.searchParams.get("t"), new Date(NOW.getTime() + TICKET_TTL_MS))).toBe(false);
  });

  it("sends nothing to post when the form breaks a rule, and shows TikTok's own words when it refuses", async () => {
    keysOn();
    const ask = async (over: Partial<typeof form>, init: () => Response = () => json({ data: {}, error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "Please review our integration guidelines." } })) => {
      const calls = fakeFetch(withShare((url) => (url.endsWith("/creator_info/query/") ? json(creatorJson(PRIVATE_ACCOUNT)) : init())));
      const res = await post(withCookies("https://kicksma.sh/api/tiktok/post", { [TOKEN_COOKIE]: token() }, { method: "POST", body: { ...form, code, ...over } }));
      return { status: res.status, body: await res.json(), inits: calls.filter((c) => c.url.endsWith("/video/init/")).length };
    };
    expect(await ask({ privacy: "PUBLIC_TO_EVERYONE" })).toMatchObject({ status: 400, body: { ok: false, error: { code: "privacy" } }, inits: 0 });
    expect(await ask({ commercial: true })).toMatchObject({ body: { error: { code: "commercial" } }, inits: 0 });
    expect(await ask({ commercial: true, branded: true })).toMatchObject({ body: { error: { code: "branded_private" } }, inits: 0 });
    expect(await ask({ durationSec: 601 })).toMatchObject({ body: { error: { code: "too_long" } }, inits: 0 });
    expect(await ask({ allowDuet: "yes" as unknown as boolean })).toMatchObject({ body: { error: { code: "bad_request" } }, inits: 0 });
    expect(await ask({})).toMatchObject({ status: 409, body: { ok: false, error: { code: "unaudited_client_can_only_post_to_private_accounts", message: "Please review our integration guidelines." }, reconnect: false }, inits: 1 });
    expect(readPostForm({ ...form, title: 7 })).toBeNull();
  });

  it("refuses a request with no token, from another site, or with the keys off, before TikTok hears anything", async () => {
    keysOn();
    const calls = fakeFetch(() => json(creatorJson(PUBLIC)));
    const none = await post(withCookies("https://kicksma.sh/api/tiktok/post", {}, { method: "POST", body: { ...form, code } }));
    expect([none.status, (await none.json()).reconnect]).toEqual([401, true]);
    const cross = await post(withCookies("https://kicksma.sh/api/tiktok/post", { [TOKEN_COOKIE]: token() }, { method: "POST", body: { ...form, code }, headers: { origin: "https://evil.example" } }));
    expect(cross.status).toBe(403);
    delete process.env.TIKTOK_CLIENT_KEY;
    expect((await post(withCookies("https://kicksma.sh/api/tiktok/post", { [TOKEN_COOKIE]: token() }, { method: "POST", body: { ...form, code } }))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("posts nothing for a reel with no public version, and TikTok hears nothing of it", async () => {
    keysOn();
    const send = async (share: number) => {
      const calls = fakeFetch(withShare(() => json(creatorJson(PUBLIC)), share));
      const res = await post(withCookies("https://kicksma.sh/api/tiktok/post", { [TOKEN_COOKIE]: token() }, { method: "POST", body: { ...form, code } }));
      return { status: res.status, body: await res.json(), tiktok: calls.filter(isTikTok).length };
    };
    expect(await send(404)).toMatchObject({ status: 409, body: { ok: false, error: { code: "old_reel" }, reconnect: false }, tiktok: 0 });
    expect(await send(410)).toMatchObject({ status: 409, body: { error: { code: "old_reel" } }, tiktok: 0 });
    // A reel host that is down is not an old reel: try later, and still nothing to TikTok.
    expect(await send(502)).toMatchObject({ status: 503, body: { error: { code: "reel_unavailable" } }, tiktok: 0 });
  });

  it("builds the commercial toggles only while commercial content is on", () => {
    const f: PostForm = { ...initialForm("x"), privacy: "PUBLIC_TO_EVERYONE", commercial: false, yourBrand: true, branded: true };
    expect(initBody(PUBLIC, f, "https://kicksma.sh/v").post_info).toMatchObject({ brand_content_toggle: false, brand_organic_toggle: false, disable_comment: true, disable_duet: true, disable_stitch: true });
    expect(initBody(PUBLIC, { ...f, commercial: true }, "https://kicksma.sh/v").post_info).toMatchObject({ brand_content_toggle: true, brand_organic_toggle: true });
  });
});

describe("the file TikTok pulls", () => {
  const at = (ticket: string | null, file = `${code}.mp4`, headers: Record<string, string> = {}) =>
    [new NextRequest(`https://kicksma.sh/api/tiktok/video/${file}${ticket === null ? "" : `?t=${encodeURIComponent(ticket)}`}`, { headers }), { params: Promise.resolve({ file }) }] as const;

  it("opens only with a ticket of this match that has not run out, before the reel host is asked", async () => {
    keysOn();
    const calls = fakeFetch(() => new Response("x"));
    expect((await video(...at(null))).status).toBe(403);
    expect((await video(...at(videoTicket("WXYZ", NOW)))).status).toBe(403);
    const [end, sig] = videoTicket(code, NOW).split(".");
    expect((await video(...at(`${end}.${(sig[0] === "A" ? "B" : "A") + sig.slice(1)}`))).status).toBe(403);
    expect((await video(...at(`${(NOW.getTime() + 2 * TICKET_TTL_MS).toString(36)}.${sig}`))).status).toBe(403);
    expect((await video(...at(videoTicket(code, new Date(NOW.getTime() - TICKET_TTL_MS))))).status).toBe(403);
    expect((await video(...at(videoTicket(code, NOW), `${code}.mov`))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("streams the reel's public version (share.mp4, never tall.mp4) with the Range header passed through, answering 206 with the range, and never redirects", async () => {
    keysOn();
    let push: ((b: Uint8Array) => void) | null = null;
    let end: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        push = (b) => c.enqueue(b);
        end = () => c.close();
      },
    });
    const calls = fakeFetch(() => new Response(stream, { status: 206, headers: { "content-type": "application/octet-stream", "content-length": "100", "content-range": "bytes 0-99/83886080", "x-host-secret": "never" } }));
    const res = await video(...at(videoTicket(code, NOW), `${code}.mp4`, { range: "bytes=0-99" }));
    // The answer is here while the reel host has sent nothing yet: the body is passed on as it arrives.
    expect(res.status).toBe(206);
    expect(calls.map((c) => c.url)).toEqual([SHARE_URL]);
    expect(headerOf(calls[0].init, "range")).toBe("bytes=0-99");
    expect(Object.fromEntries(res.headers)).toMatchObject({ "content-type": "video/mp4", "content-length": "100", "content-range": "bytes 0-99/83886080", "accept-ranges": "bytes" });
    expect(res.headers.get("x-host-secret")).toBeNull();
    expect(res.headers.get("location")).toBeNull();
    const reader = res.body!.getReader();
    push!(new Uint8Array([1, 2, 3]));
    expect(Array.from((await reader.read()).value!)).toEqual([1, 2, 3]);
    push!(new Uint8Array([4]));
    end!();
    expect(Array.from((await reader.read()).value!)).toEqual([4]);
    expect((await reader.read()).done).toBe(true);
  });

  it("answers the whole file as 200, a HEAD with the length and no body, and a reel host failure as 502", async () => {
    keysOn();
    let calls = fakeFetch((_, init) => new Response(init.method === "HEAD" ? null : "abc", { status: 200, headers: { "content-length": "3" } }));
    const whole = await video(...at(videoTicket(code, NOW)));
    expect([whole.status, whole.headers.get("content-length"), whole.headers.get("accept-ranges"), await whole.text()]).toEqual([200, "3", "bytes", "abc"]);
    expect(headerOf(calls[0].init, "range")).toBeNull();
    const head = await videoHead(...at(videoTicket(code, NOW)));
    expect([head.status, head.headers.get("content-length"), head.body]).toEqual([200, "3", null]);
    expect(calls.map((c) => c.url)).toEqual([SHARE_URL, SHARE_URL]);
    // A reel made before TikTok sharing: no share.mp4 on the reel host, so TikTok gets nothing, and the tall reel is never asked for.
    calls = fakeFetch(() => new Response("gone", { status: 404 }));
    expect((await video(...at(videoTicket(code, NOW)))).status).toBe(502);
    expect(calls.map((c) => c.url)).toEqual([SHARE_URL]);
    calls = fakeFetch(() => new Response(null, { status: 416, headers: { "content-range": "bytes */3" } }));
    const bad = await video(...at(videoTicket(code, NOW), `${code}.mp4`, { range: "bytes=9-" }));
    expect([bad.status, bad.headers.get("content-range")]).toEqual([416, "bytes */3"]);
  });
});

describe("the reel's public version", () => {
  it("is there for a 200 or 206, not there for the reel host's 404 or 410, and unknown for anything else", () => {
    expect([200, 206].map(shareFileOf)).toEqual(["yes", "yes"]);
    expect([404, 410].map(shareFileOf)).toEqual(["no", "no"]);
    expect([null, 301, 403, 500, 502, 503].map(shareFileOf)).toEqual(["unknown", "unknown", "unknown", "unknown", "unknown", "unknown"]);
  });

  it("is asked with one HEAD and a short time-out, and a fault or a time-out is unknown, never an old reel", async () => {
    const calls: Call[] = [];
    const answering = (status: number) => async (url: string | URL | Request, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return new Response(null, { status });
    };
    expect(await shareFileThere(SHARE_URL, answering(200) as typeof fetch)).toBe("yes");
    expect(await shareFileThere(SHARE_URL, answering(404) as typeof fetch)).toBe("no");
    expect(calls.map((c) => [c.url, c.init.method, c.init.signal instanceof AbortSignal])).toEqual([
      [SHARE_URL, "HEAD", true],
      [SHARE_URL, "HEAD", true],
    ]);
    expect(SHARE_CHECK_MS).toBeLessThanOrEqual(5000);
    const timedOut = (async () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    }) as typeof fetch;
    expect(await shareFileThere(SHARE_URL, timedOut)).toBe("unknown");
  });
});

describe("an account TikTok does not let in yet", () => {
  it("is named by TikTok's own codes for an unreviewed or unaudited app, and nothing else", () => {
    for (const c of ["unaudited_client_can_only_post_to_private_accounts", "reached_active_user_cap", "access_denied", "unauthorized_client"]) expect(notAllowedYet(c), c).toBe(true);
    for (const c of ["spam_risk_too_many_posts", "access_token_invalid", "privacy_level_option_mismatch", "network", "", undefined]) expect(notAllowedYet(c), String(c)).toBe(false);
  });

  it("has one plain line in every language, and the reel made before TikTok sharing has its own", async () => {
    const { default: en } = await import("../messages/en.json");
    const { default: ru } = await import("../messages/ru.json");
    const { default: es } = await import("../messages/es.json");
    expect(en.tiktok.inTest).toBe("TikTok sharing is in test. For now it works for invited accounts set to private.");
    for (const m of [en, ru, es]) {
      for (const k of ["inTest", "oldReel", "reelDown"] as const) expect(m.tiktok[k].length, k).toBeGreaterThan(20);
      expect(m.tiktok.inTest).not.toContain("{");
    }
  });
});

describe("the status", () => {
  it("maps TikTok's status to working, done or failed with its reason", () => {
    const ok = { code: "ok", message: "" };
    expect(statusOf({ data: { status: "PROCESSING_DOWNLOAD" }, error: ok })).toEqual({ ok: true, status: { state: "working" } });
    expect(statusOf({ data: { status: "PUBLISH_COMPLETE" }, error: ok })).toEqual({ ok: true, status: { state: "done" } });
    expect(statusOf({ data: { status: "FAILED", fail_reason: "file_format_check_failed" }, error: ok })).toEqual({ ok: true, status: { state: "failed", reason: "file_format_check_failed" } });
    expect(statusOf({ error: { code: "access_token_invalid", message: "The access token is invalid." } })).toEqual({ ok: false, error: { code: "access_token_invalid", message: "The access token is invalid." } });
  });

  it("asks TikTok with the cookie's token and the publish id, and tells the page to connect again for a dead token", async () => {
    keysOn();
    let calls = fakeFetch(() => json({ data: { status: "PUBLISH_COMPLETE" }, error: { code: "ok", message: "" } }));
    const res = await status(withCookies("https://kicksma.sh/api/tiktok/status", { [TOKEN_COOKIE]: token() }, { method: "POST", body: { publishId: "v_pub_url~v2.123" } }));
    expect(await res.json()).toEqual({ ok: true, status: { state: "done" } });
    expect(calls[0].url).toBe(`${TIKTOK}/v2/post/publish/status/fetch/`);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ publish_id: "v_pub_url~v2.123" });
    calls = fakeFetch(() => json({ error: { code: "access_token_invalid", message: "The access token is invalid." } }));
    const dead = await status(withCookies("https://kicksma.sh/api/tiktok/status", { [TOKEN_COOKIE]: token() }, { method: "POST", body: { publishId: "v_pub_url~v2.123" } }));
    expect(await dead.json()).toMatchObject({ ok: false, reconnect: true });
    const bad = await status(withCookies("https://kicksma.sh/api/tiktok/status", { [TOKEN_COOKIE]: token() }, { method: "POST", body: { publishId: "../x y" } }));
    expect(bad.status).toBe(400);
  });
});
