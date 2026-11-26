/**
 * "Share to TikTok" (the owner, 26 November 2026): a player posts the reel of their match to their own
 * TikTok, through TikTok's Login Kit and the Content Posting API (Direct Post), and @kicksma.sh posts
 * through the same flow. Pure: no fetch, no clock of its own, no cookie. The calls are in
 * `src/lib/tiktok/api.ts`, the seals in `src/lib/tiktok/seal.ts`.
 *
 * The posting page follows TikTok's Content Sharing Guidelines, and the rules of its form are here so
 * the page and the server ask the same ones:
 *   - the creator's own privacy options only, and no default;
 *   - Comment, Duet and Stitch all off at first, and locked off where the creator's settings turn them off;
 *   - commercial content off at first; on, "Your brand" or "Branded content" must be chosen, and branded
 *     content can never be private;
 *   - nothing goes to TikTok before the player presses Post;
 *   - the reel goes as it is: no watermark, no logo, no text on the video.
 */

export const TIKTOK_AUTHORIZE_URL = "https://www.tiktok.com/v2/auth/authorize/";
export const TIKTOK_API = "https://open.tiktokapis.com";
export const TIKTOK_SCOPES = ["user.info.basic", "video.publish", "video.upload"] as const;
/** The scope without which nothing can be posted: a player can untick it on TikTok's own screen. */
export const POST_SCOPE = "video.publish";
/** TikTok's limit for a video's title, in UTF-16 code units. */
export const TITLE_MAX = 2200;
/** The frame TikTok shows as the cover: one second in, past the reel's dark first frame. */
export const COVER_MS = 1000;
/** The posting page polls the status this often at most (TikTok allows 30 a minute), and stops after this long. */
export const STATUS_EVERY_MS = 5000;
export const STATUS_STOP_MS = 15 * 60_000;

/** The privacy level that is "Only me". The page names each level TikTok knows in words (`privacyName` in `TikTokPost`). */
export const PRIVATE = "SELF_ONLY";

/**
 * A PKCE code verifier as TikTok takes one: "a high-entropy cryptographic random string using the unreserved
 * characters [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~", with a minimum length of 43 characters and a maximum
 * length of 128 characters" (developers.tiktok.com/doc/login-kit-desktop, read 26 November 2026).
 */
export const isCodeVerifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(v);

/**
 * The address TikTok's own sign-in screen opens on, with PKCE. TikTok's page for web lists no PKCE, but TikTok's
 * own screen refused a web sign-in without it ("error_type=code_challenge", 26 November 2026), so the address
 * carries the challenge as TikTok's desktop page states it: `code_challenge` is the hex SHA-256 of the verifier
 * (`codeChallenge` in src/lib/tiktok/seal.ts) and `code_challenge_method` is always `S256`.
 */
export function authorizeUrl(o: { clientKey: string; redirectUri: string; state: string; codeChallenge: string }): string {
  const u = new URL(TIKTOK_AUTHORIZE_URL);
  u.searchParams.set("client_key", o.clientKey);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", TIKTOK_SCOPES.join(","));
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("state", o.state);
  u.searchParams.set("code_challenge", o.codeChallenge);
  u.searchParams.set("code_challenge_method", "S256");
  return u.toString();
}

/** Why the sign-in went back to the reel page (`?tiktok=<why>`): the page says it in our own words, never words from the address. */
export const CALLBACK_WHY = ["denied", "expired", "failed", "scope"] as const;
export type CallbackWhy = (typeof CALLBACK_WHY)[number];
export const callbackWhyOf = (v: unknown): CallbackWhy | null => ((CALLBACK_WHY as readonly string[]).includes(String(v)) ? (v as CallbackWhy) : null);

/** What TikTok answered, when it refused: its own code and its own words, shown to the player as they are. */
export type TikTokError = { code: string; message: string };

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const bool = (v: unknown): boolean => v === true;

/** TikTok's `error` object of an API answer: null for `"ok"`, else its code and words. An answer with neither is a refusal too. */
export function apiErrorOf(json: unknown): TikTokError | null {
  const e = (json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (e && typeof e === "object" && e.code === "ok") return null;
  if (e && typeof e === "object") return { code: str(e.code, 100) || "unknown", message: str(e.message) };
  return { code: "bad_answer", message: "" };
}

/** The token TikTok gave for a code, or its refusal. The token endpoint names its error as a string beside `error_description`. */
export type TikTokToken = { accessToken: string; openId: string; scopes: string[]; expiresAt: number };
export function tokenOf(json: unknown, now: Date): { ok: true; token: TikTokToken } | { ok: false; error: TikTokError } {
  const j = (json ?? {}) as { access_token?: unknown; open_id?: unknown; scope?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown };
  const accessToken = str(j.access_token, 2000);
  const expiresIn = Number(j.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return { ok: false, error: { code: str(j.error, 100) || "bad_answer", message: str(j.error_description) } };
  }
  const scopes = str(j.scope, 500).split(",").map((s) => s.trim()).filter(Boolean);
  return { ok: true, token: { accessToken, openId: str(j.open_id, 200), scopes, expiresAt: now.getTime() + Math.floor(expiresIn) * 1000 } };
}

/** The creator's account as `creator_info/query` describes it. */
export type Creator = {
  avatarUrl: string | null;
  username: string;
  nickname: string;
  privacyOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxDurationSec: number;
};

/** The creator, or TikTok's refusal. A refusal of creator info means this account cannot post now (TikTok's guideline: stop and say "try again later"). */
export function creatorOf(json: unknown): { ok: true; creator: Creator } | { ok: false; error: TikTokError } {
  const error = apiErrorOf(json);
  if (error) return { ok: false, error };
  const d = ((json as { data?: unknown }).data ?? {}) as Record<string, unknown>;
  const privacyOptions = Array.isArray(d.privacy_level_options) ? d.privacy_level_options.filter((o): o is string => typeof o === "string" && /^[A-Z_]{1,40}$/.test(o)) : [];
  const avatar = str(d.creator_avatar_url, 2000);
  const max = Number(d.max_video_post_duration_sec);
  return {
    ok: true,
    creator: {
      avatarUrl: /^https:\/\//.test(avatar) ? avatar : null,
      username: str(d.creator_username, 100),
      nickname: str(d.creator_nickname, 100),
      privacyOptions: [...new Set(privacyOptions)],
      commentDisabled: bool(d.comment_disabled),
      duetDisabled: bool(d.duet_disabled),
      stitchDisabled: bool(d.stitch_disabled),
      maxDurationSec: Number.isFinite(max) && max > 0 ? Math.floor(max) : 0,
    },
  };
}

/** Whether a refusal means the player's token is no good any more, so the way out is to connect again (not "try later"). */
export const needsReconnect = (e: TikTokError): boolean => ["access_token_invalid", "scope_not_authorized", "scope_permission_missed"].includes(e.code);

/** What the form starts from: no privacy chosen, every interaction off, commercial content off. */
export type PostForm = {
  title: string;
  privacy: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  commercial: boolean;
  yourBrand: boolean;
  branded: boolean;
};
export const initialForm = (title: string): PostForm => ({ title: title.slice(0, TITLE_MAX), privacy: "", allowComment: false, allowDuet: false, allowStitch: false, commercial: false, yourBrand: false, branded: false });

/** What each control of the form may do for this creator. */
export type FormRules = {
  privacyOptions: string[];
  comment: { disabled: boolean };
  duet: { disabled: boolean };
  stitch: { disabled: boolean };
  /** "Branded content" cannot be chosen while the privacy is "Only me". */
  brandedDisabled: boolean;
  /** "Only me" cannot be chosen while branded content is on. */
  privateDisabled: boolean;
};
export function formRules(creator: Creator, form: Pick<PostForm, "privacy" | "commercial" | "branded">): FormRules {
  return {
    privacyOptions: creator.privacyOptions,
    comment: { disabled: creator.commentDisabled },
    duet: { disabled: creator.duetDisabled },
    stitch: { disabled: creator.stitchDisabled },
    brandedDisabled: form.privacy === PRIVATE,
    privateDisabled: form.commercial && form.branded,
  };
}

/** The label TikTok puts on a post with commercial content, as a message key, or null while there is none to say. */
export function commercialLabel(form: Pick<PostForm, "commercial" | "yourBrand" | "branded">): "commercialPick" | "labelPaid" | "labelPromo" | null {
  if (!form.commercial) return null;
  if (form.branded) return "labelPaid";
  if (form.yourBrand) return "labelPromo";
  return "commercialPick";
}

/** Why Post is not ready yet, or null when it is. The page shows the button off for any of these; the server refuses the same ones. */
export type NotReady = "privacy" | "commercial" | "branded_private" | "too_long" | "title";
export function notReady(creator: Creator, form: PostForm, durationSec: number | null): NotReady | null {
  if ([...form.title].length === 0 || form.title.length > TITLE_MAX) return "title";
  if (!form.privacy || !creator.privacyOptions.includes(form.privacy)) return "privacy";
  if (form.commercial && !form.yourBrand && !form.branded) return "commercial";
  if (form.commercial && form.branded && form.privacy === PRIVATE) return "branded_private";
  if (durationSec !== null && creator.maxDurationSec > 0 && durationSec > creator.maxDurationSec) return "too_long";
  return null;
}

/** A form as the browser sent it, read strictly: anything that is not a string or a boolean of its own field is refused. */
export function readPostForm(raw: unknown): { form: PostForm; durationSec: number | null } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.title !== "string" || typeof r.privacy !== "string") return null;
  const flags = ["allowComment", "allowDuet", "allowStitch", "commercial", "yourBrand", "branded"] as const;
  if (flags.some((k) => typeof r[k] !== "boolean")) return null;
  const d = r.durationSec;
  const durationSec = typeof d === "number" && Number.isFinite(d) && d > 0 && d < 86_400 ? d : null;
  return {
    form: { title: r.title.trim(), privacy: r.privacy, allowComment: r.allowComment as boolean, allowDuet: r.allowDuet as boolean, allowStitch: r.allowStitch as boolean, commercial: r.commercial as boolean, yourBrand: r.yourBrand as boolean, branded: r.branded as boolean },
    durationSec,
  };
}

/**
 * The body of `post/publish/video/init/`: Direct Post, TikTok pulls the file from our verified address.
 * An interaction the creator's settings turn off goes as disabled whatever the form says, and the
 * commercial toggles go only while commercial content is on.
 */
export function initBody(creator: Creator, form: PostForm, videoUrl: string) {
  return {
    post_info: {
      title: form.title,
      privacy_level: form.privacy,
      disable_comment: creator.commentDisabled || !form.allowComment,
      disable_duet: creator.duetDisabled || !form.allowDuet,
      disable_stitch: creator.stitchDisabled || !form.allowStitch,
      video_cover_timestamp_ms: COVER_MS,
      brand_content_toggle: form.commercial && form.branded,
      brand_organic_toggle: form.commercial && form.yourBrand,
    },
    source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
  };
}

/** The publish id of an accepted post, or TikTok's refusal. */
export function publishIdOf(json: unknown): { ok: true; publishId: string } | { ok: false; error: TikTokError } {
  const error = apiErrorOf(json);
  if (error) return { ok: false, error };
  const id = str((json as { data?: { publish_id?: unknown } }).data?.publish_id, 200);
  return id ? { ok: true, publishId: id } : { ok: false, error: { code: "bad_answer", message: "" } };
}

/** A publish id as the browser sends it back: TikTok's shape (`v_pub_url~v2.123…`), bounded. */
export const isPublishId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_.~-]{1,200}$/.test(v);

/** Where a post stands, for the page: still working, on the profile, or failed with TikTok's reason. */
export type PostStatus = { state: "working" } | { state: "done" } | { state: "failed"; reason: string };
export function statusOf(json: unknown): { ok: true; status: PostStatus } | { ok: false; error: TikTokError } {
  const error = apiErrorOf(json);
  if (error) return { ok: false, error };
  const d = ((json as { data?: unknown }).data ?? {}) as { status?: unknown; fail_reason?: unknown };
  const s = str(d.status, 60);
  if (s === "PUBLISH_COMPLETE") return { ok: true, status: { state: "done" } };
  if (s === "FAILED") return { ok: true, status: { state: "failed", reason: str(d.fail_reason, 200) || "unknown" } };
  return { ok: true, status: { state: "working" } };
}

/** The reel's address on our own verified prefix, for TikTok to pull: `/api/tiktok/video/<code>.mp4?t=<ticket>`. */
export const videoPath = (code: string, ticket: string) => `/api/tiktok/video/${code}.mp4?t=${encodeURIComponent(ticket)}`;
/** The match code of a video route's file name (`ABCD.mp4`), or null. */
export const codeOfVideoFile = (file: string): string | null => /^([A-Za-z0-9]{4})\.mp4$/.exec(file)?.[1] ?? null;
