import { detectPlatform } from "./platforms";

/**
 * The one read of a pasted booking link, as a chat app's link-preview robot reads it (DECIDING rule
 * 35). A person who booked a court in a platform's app pastes the link the app gave them; a chat app
 * shows that link with a title and a description, because the platform hands its preview robot a page
 * with them. Kicksmash asks for the same page, once, and fills the match form from it.
 *
 * The limits, each one a test in `tests/booking-unfurl.test.ts`:
 * - only https, only a host of a platform in `PLATFORMS` (no address in figures, no user name or
 *   password in the link, no port but 443); anything else is null with no request;
 * - one GET, no cookie, no sign-in; at most three redirects, each held to the same check, and a
 *   redirect to an app store, a custom scheme or any other host ends the read with what it has;
 * - four seconds for the network, and the first 256 KB of an HTML page, then the read stops; the
 *   parse of that page is linear in its length (a tag of 4 KB at most, an attribute name of 64
 *   letters at most), so a page built to stall it costs milliseconds, not the minute it once did;
 * - only the title and the description (og:, twitter: and <title>), and, from a Branch link's click
 *   data, the kind of link and the platform's own id for it; every other key is dropped;
 * - a 401, 403 or 429, any other answer that is not a page, a timeout or a page with nothing in it is
 *   null, and nothing is tried again. The link and the page are never logged: a pasted link can carry
 *   a token. Pure apart from the one fetch; the caller decides whether the platform may be read now
 *   (`mayRead` in `paste.ts`) and counts (`paste_preview_ok`, `paste_preview_fail`, `paste_preview_off`).
 */

/**
 * What the read says it is. The owner, 11 October 2026, on an earlier session that refused this:
 * "“we do not pretend to be WhatsApp's link-preview robot to get a preview” why would you think that?
 * that’s a great idea to get the match details, do it, update the rules if that is conflict somewhere".
 * So the read is WhatsApp's preview robot as a platform knows it ("WhatsApp/2"), and it still names
 * Kicksmash and the page that says what it reads (/about#bot). The Padel Society's Branch link gave
 * its og tags and its click data to this string on 11 October 2026 (one request, checked by hand).
 * The 15-minute reader of free court times keeps its own name alone (`KicksmashBot/1.0`): this string
 * is for the one read of a link a person pasted, and for nothing else.
 */
export const PREVIEW_USER_AGENT = "WhatsApp/2.24.20.80 A (compatible; KicksmashBot/1.0; +https://kicksma.sh/about#bot)";
export const PREVIEW_TIMEOUT_MS = 4000;
export const PREVIEW_MAX_BYTES = 256 * 1024;
export const PREVIEW_MAX_HOPS = 3;
const VALUE_MAX = 300;

export type LinkPreview = { title: string | null; description: string | null; siteName: string | null; ref: { type: string; id: string } | null };

/** A link the read may open: https, a platform's host, no address in figures, no user name, port 443. Null for anything else. */
export function previewTarget(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password) return null;
  // The parser drops ":443" for https, so any port left is another one.
  if (u.port !== "") return null;
  const host = u.hostname.toLowerCase();
  if (host.startsWith("[") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  return detectPlatform(u.toString()) ? u : null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };

/** HTML entities, named (the five and nbsp) and numbered; anything else stays as written. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,6});/gi, (all, code: string) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()] ?? all;
    const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "";
  });
}

/** One line of plain text, 300 characters at most: no control character, one space between words. */
const clean = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, VALUE_MAX)
    .trim();
  return s || null;
};

const TYPE = /^[A-Za-z][A-Za-z_]{0,39}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLICK = /link_click_id(?:=|&#x3d;|&#61;|%3d)link-\d{1,30}-([A-Za-z0-9_-]{8,12000})/gi;

/** The match id a click data names: digits or a uuid, 64 characters at most. */
const idOf = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return String(v);
  if (typeof v === "string" && v.length <= 64 && (/^\d{1,64}$/.test(v) || UUID.test(v))) return v;
  return null;
};

/**
 * A Branch link's click data (`link_click_id=link-<digits>-<base64url JSON>`, in the app links of the
 * page or of a redirect): the kind of link and the match id, and the title and description the link
 * was made with. Every other key is dropped. Null when there is none or it does not decode.
 */
export function clickData(html: string): { ref: LinkPreview["ref"]; title: string | null; description: string | null } | null {
  for (const m of html.matchAll(CLICK)) {
    try {
      const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
      const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const d = data as Record<string, unknown>;
      const type = typeof d.type === "string" && TYPE.test(d.type) ? d.type : null;
      const id = idOf(d.matchId) ?? idOf(d.match_id) ?? idOf(d.id);
      return { ref: type && id ? { type, id } : null, title: clean(d.$og_title), description: clean(d.$og_description) };
    } catch {
      continue;
    }
  }
  return null;
}

/** The longest tag the parse reads; a longer one is skipped whole. */
const TAG_MAX = 4096;
const ATTR_RE = /([a-zA-Z:_-]{1,64})\s{0,8}=\s{0,8}(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * Each `<name …>` tag of the page, in order, up to its first ">", without a regular expression that
 * looks ahead for the ">": the next ">" is found once, so a page of tags that never close is read in
 * one pass. A tag longer than `TAG_MAX` is skipped; with no ">" left in the page, nothing after it is a tag.
 */
function* tagsOf(html: string, name: string): Generator<{ tag: string; end: number }> {
  const open = new RegExp(`<${name}(?![a-zA-Z0-9_-])`, "gi");
  for (let m = open.exec(html); m; m = open.exec(html)) {
    const end = html.indexOf(">", m.index);
    if (end < 0) return;
    open.lastIndex = end + 1;
    if (end - m.index < TAG_MAX) yield { tag: html.slice(m.index, end + 1), end: end + 1 };
  }
}

/** The preview a page carries: its og and twitter tags, its <title>, and a Branch link's click data. Null for a page with none of them. Pure, and linear in the page's length. */
export function parsePreview(html: string): LinkPreview | null {
  const meta = new Map<string, string>();
  let n = 0;
  for (const { tag } of tagsOf(html, "meta")) {
    if (++n > 400) break;
    const attrs = new Map<string, string>();
    for (const a of tag.matchAll(ATTR_RE)) attrs.set(a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? "");
    const key = (attrs.get("property") ?? attrs.get("name") ?? "").toLowerCase();
    const content = attrs.get("content");
    if (key && content !== undefined && !meta.has(key)) meta.set(key, decodeEntities(content));
  }
  let titleTag: string | undefined;
  for (const { end } of tagsOf(html, "title")) {
    titleTag = /^[^<]{0,2000}(?=<\/title>)/i.exec(html.slice(end, end + 2010))?.[0];
    break;
  }
  const click = clickData(html);
  const title = clean(meta.get("og:title")) ?? clean(meta.get("twitter:title")) ?? clean(titleTag ? decodeEntities(titleTag) : null) ?? click?.title ?? null;
  const description = clean(meta.get("og:description")) ?? clean(meta.get("twitter:description")) ?? click?.description ?? null;
  const siteName = clean(meta.get("og:site_name"));
  const ref = click?.ref ?? null;
  return title || description || siteName || ref ? { title, description, siteName, ref } : null;
}

/** The first `max` bytes of the body as text: the stream is read in pieces and cancelled at the cap. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const piece = value.byteLength > max - bytes ? value.subarray(0, max - bytes) : value;
    bytes += piece.byteLength;
    text += decoder.decode(piece, { stream: true });
    if (bytes >= max) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text + decoder.decode();
}

const drop = (res: Response) => res.body?.cancel().catch(() => undefined);

/**
 * Reads a pasted booking link's preview, once. Null when the link is not one the read may open, or the
 * platform said no, or the page says nothing. Never throws, never retries, never logs the link.
 */
export async function readLinkPreview(url: string, o: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<LinkPreview | null> {
  let target = previewTarget(url);
  if (!target) return null;
  const fetchImpl = o.fetchImpl ?? fetch;
  // A timer takes a whole number, and the clock that measures what is left never is one.
  const signal = AbortSignal.timeout(Math.max(1, Math.floor(o.timeoutMs ?? PREVIEW_TIMEOUT_MS)));
  try {
    for (let hop = 0; ; hop++) {
      const res = await fetchImpl(target.toString(), {
        method: "GET",
        redirect: "manual",
        signal,
        headers: { "user-agent": PREVIEW_USER_AGENT, accept: "text/html", "accept-language": "en" },
      });
      if (res.status >= 300 && res.status < 400) {
        await drop(res);
        const location = res.headers.get("location");
        if (!location) return null;
        let next: URL | null = null;
        try {
          next = previewTarget(new URL(location, target).toString());
        } catch {
          next = null;
        }
        // An app store, the app's own scheme, another host, or a fourth hop: the read ends here, with what the address itself says.
        if (!next || hop >= PREVIEW_MAX_HOPS) {
          const click = clickData(location);
          return click && (click.ref || click.title || click.description) ? { title: click.title, description: click.description, siteName: null, ref: click.ref } : null;
        }
        target = next;
        continue;
      }
      if (res.status < 200 || res.status >= 300 || !/^\s*text\/html\b/i.test(res.headers.get("content-type") ?? "")) {
        await drop(res);
        return null;
      }
      return parsePreview(await readCapped(res, PREVIEW_MAX_BYTES));
    }
  } catch {
    return null;
  }
}
