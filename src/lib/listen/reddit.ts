/**
 * Posting a reply on Reddit as the project's own account, only after a human
 * approved the exact text. Script-app OAuth (password grant), one comment
 * per call, nothing else. Disabled without the four env vars.
 */
export const redditEnabled = () => Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET && process.env.REDDIT_USERNAME && process.env.REDDIT_PASSWORD);
const UA = () => `web:sh.kicksma.listen:1.0 (by /u/${process.env.REDDIT_USERNAME ?? "kicksmash"})`;

let cached: { token: string; until: number } | null = null;

async function token(fetchImpl: typeof fetch): Promise<string> {
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const basic = Buffer.from(`${process.env.REDDIT_CLIENT_ID}:${process.env.REDDIT_CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "password", username: process.env.REDDIT_USERNAME!, password: process.env.REDDIT_PASSWORD!, scope: "submit read" });
  const res = await fetchImpl("https://www.reddit.com/api/v1/access_token", { method: "POST", headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", "user-agent": UA() }, body, signal: AbortSignal.timeout(15_000) });
  const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string } | null;
  if (!res.ok || !json?.access_token) throw new Error(`reddit token: ${json?.error ?? res.status}`);
  cached = { token: json.access_token, until: Date.now() + (json.expires_in ?? 3600) * 1000 };
  return cached.token;
}

export type RedditPostResult = { ok: true; url: string; id: string } | { ok: false; error: string };

/** Comments on a post (t3_) or replies to a comment (t1_). Returns the permalink of the new comment. */
export async function postRedditComment(thingId: string, text: string, fetchImpl: typeof fetch = fetch): Promise<RedditPostResult> {
  if (!redditEnabled()) return { ok: false, error: "reddit disabled" };
  try {
    const t = await token(fetchImpl);
    const res = await fetchImpl("https://oauth.reddit.com/api/comment", {
      method: "POST",
      headers: { authorization: `Bearer ${t}`, "content-type": "application/x-www-form-urlencoded", "user-agent": UA() },
      body: new URLSearchParams({ api_type: "json", thing_id: thingId, text }),
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => null)) as { json?: { errors?: unknown[][]; data?: { things?: { data?: { id?: string; permalink?: string } }[] } } } | null;
    const errors = json?.json?.errors ?? [];
    if (!res.ok || errors.length) return { ok: false, error: errors.length ? String(errors[0]?.[1] ?? errors[0]?.[0]) : `HTTP ${res.status}` };
    const thing = json?.json?.data?.things?.[0]?.data;
    if (!thing?.id) return { ok: false, error: "no comment id returned" };
    return { ok: true, id: thing.id, url: thing.permalink ? `https://www.reddit.com${thing.permalink}` : `https://www.reddit.com/comments/${thingId.replace(/^t3_/, "")}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
