// A fake TikTok for the browser suites' server, loaded before Next.js starts (`--import` in NODE_OPTIONS, set by
// e2e/run.mjs), beside the fake Playtomic. It answers only open.tiktokapis.com, and only for the app key, the codes and
// the tokens of the suites ("e2e-..."); every other request goes to the real fetch. So no suite ever calls TikTok.
//
// TikTok's own sign-in screen (www.tiktok.com) is a page in the browser, not a server call: the suite answers it with
// a redirect to our callback (`page.route`), with `e2e-public` or `e2e-private` as the code. Each code gives a token
// for one of two accounts: a public one with every option, and a private one whose settings turn Duet and Stitch off.
const KEY = "e2e-tiktok-key";
const SECRET = "e2e-tiktok-secret";
const ACCOUNTS = {
  "e2e-tok-public": {
    creator_avatar_url: "https://tiktok-avatar.example.test/public.png",
    creator_username: "e2e.public",
    creator_nickname: "Public Padel",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
    max_video_post_duration_sec: 600,
  },
  "e2e-tok-private": {
    creator_avatar_url: "https://tiktok-avatar.example.test/private.png",
    creator_username: "e2e.private",
    creator_nickname: "Private Padel",
    privacy_level_options: ["FOLLOWER_OF_CREATOR", "SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: true,
    stitch_disabled: true,
    max_video_post_duration_sec: 600,
  },
};
const OK = { code: "ok", message: "", log_id: "e2e" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
globalThis.fetch = async function fakeTikTok(input, init = {}) {
  let url;
  try {
    url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
  } catch {
    return realFetch(input, init);
  }
  if (url.hostname !== "open.tiktokapis.com") return realFetch(input, init);
  const body = typeof init.body === "string" ? init.body : "";
  if (url.pathname === "/v2/oauth/token/") {
    const f = new URLSearchParams(body);
    if (f.get("client_key") !== KEY || f.get("client_secret") !== SECRET || f.get("grant_type") !== "authorization_code" || !/\/api\/tiktok\/callback$/.test(f.get("redirect_uri") ?? "") || !/^[A-Za-z0-9._~-]{43,128}$/.test(f.get("code_verifier") ?? "")) {
      return json({ error: "invalid_client", error_description: "e2e: the app's key, secret, redirect or PKCE verifier is not the suite's" }, 401);
    }
    const which = { "e2e-public": "e2e-tok-public", "e2e-private": "e2e-tok-private" }[f.get("code") ?? ""];
    if (!which) return json({ error: "invalid_grant", error_description: "Authorization code is expired." }, 400);
    return json({ access_token: which, expires_in: 7200, open_id: `open-${which}`, refresh_token: "rft.e2e", refresh_expires_in: 86400, scope: "user.info.basic,video.publish,video.upload", token_type: "Bearer" });
  }
  const token = (new Headers(init.headers).get("authorization") ?? "").replace(/^Bearer /, "");
  const account = ACCOUNTS[token];
  if (!account) return json({ data: {}, error: { code: "access_token_invalid", message: "The access token is invalid or not found in the request.", log_id: "e2e" } }, 401);
  if (url.pathname === "/v2/post/publish/creator_info/query/") return json({ data: account, error: OK });
  if (url.pathname === "/v2/post/publish/video/init/") {
    const post = JSON.parse(body || "{}");
    if (!account.privacy_level_options.includes(post.post_info?.privacy_level)) return json({ data: {}, error: { code: "privacy_level_option_mismatch", message: "privacy_level is not one of the creator's options", log_id: "e2e" } }, 400);
    if (post.source_info?.source !== "PULL_FROM_URL" || !/\/api\/tiktok\/video\/[A-Za-z0-9]{4}\.mp4\?t=/.test(post.source_info?.video_url ?? "")) return json({ data: {}, error: { code: "invalid_params", message: "e2e: not our pull address", log_id: "e2e" } }, 400);
    return json({ data: { publish_id: "v_pub_url~v2.e2e" }, error: OK });
  }
  if (url.pathname === "/v2/post/publish/status/fetch/") return json({ data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: [] }, error: OK });
  return json({ data: {}, error: { code: "invalid_params", message: "e2e: unknown endpoint", log_id: "e2e" } }, 404);
};
