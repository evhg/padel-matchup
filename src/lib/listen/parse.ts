/**
 * Listening: turn public feeds into candidate items. Pure functions, no
 * network, so they are cheap to test. Fetching lives in sources.ts.
 */
export type ListenSource = "hn" | "reddit" | "rss";

export type Candidate = {
  source: ListenSource;
  externalId: string;
  url: string;
  title: string;
  body: string;
  author: string | null;
  postedAt: Date;
  /** Where a reply would go: the thread id the posting API needs. */
  threadId: string | null;
};

const MAX_BODY = 6000;

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Strips tags and collapses whitespace: feeds carry HTML in their bodies. */
export const stripHtml = (s: string) =>
  decode(
    decode(s)
      .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const tag = (xml: string, name: string): string | null => {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : null;
};
const attr = (xml: string, name: string, attrName: string): string | null => {
  const m = xml.match(new RegExp(`<${name}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*/?>`, "i"));
  return m ? m[1] : null;
};

/** RSS 2.0 and Atom, the two shapes Reddit and most forums publish. */
export function parseFeed(xml: string, source: ListenSource = "rss"): Candidate[] {
  const out: Candidate[] = [];
  const entries = [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>|<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  for (const e of entries) {
    const title = stripHtml(tag(e, "title") ?? "");
    const link = attr(e, "link", "href") ?? stripHtml(tag(e, "link") ?? "");
    const id = stripHtml(tag(e, "id") ?? tag(e, "guid") ?? link);
    const body = stripHtml(tag(e, "content") ?? tag(e, "description") ?? tag(e, "summary") ?? "").slice(0, MAX_BODY);
    const when = tag(e, "updated") ?? tag(e, "published") ?? tag(e, "pubDate") ?? "";
    const author = stripHtml(tag(tag(e, "author") ?? "", "name") ?? tag(e, "dc:creator") ?? tag(e, "author") ?? "") || null;
    const postedAt = new Date(when.trim());
    if (!title || !link || Number.isNaN(postedAt.getTime())) continue;
    // Reddit ids look like t3_abc123 in the <id>; keep the thing id for replies.
    const thing = id.match(/\b(t[1-6]_[a-z0-9]+)\b/i)?.[1] ?? null;
    out.push({ source, externalId: id, url: link, title, body, author, postedAt, threadId: thing });
  }
  return out;
}

type HnHit = { objectID: string; title?: string | null; story_title?: string | null; url?: string | null; story_url?: string | null; author?: string; created_at: string; comment_text?: string | null; story_text?: string | null; story_id?: number | null };

/** Hacker News via the Algolia API (stories and comments). */
export function parseHn(json: { hits?: HnHit[] }): Candidate[] {
  const out: Candidate[] = [];
  for (const h of json.hits ?? []) {
    const isComment = h.comment_text != null;
    const title = (isComment ? h.story_title : h.title)?.trim();
    if (!title) continue;
    const body = stripHtml(h.comment_text ?? h.story_text ?? "").slice(0, MAX_BODY);
    const postedAt = new Date(h.created_at);
    if (Number.isNaN(postedAt.getTime())) continue;
    out.push({
      source: "hn",
      externalId: h.objectID,
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      title,
      body,
      author: h.author ?? null,
      postedAt,
      threadId: h.objectID,
    });
  }
  return out;
}

const PADEL = /\bpadel\b|\bpádel\b|падел/i;
const INTENT = /\b(app|apps|website|tool|tools|platform|organi[sz]e|organi[sz]ing|organi[sz]er|schedule|scheduling|americano|mexicano|king of the court|find (?:players|a game|a match|people|a partner|partners)|looking for (?:players|a game|people)|match ?making|whatsapp|telegram|group chat|spreadsheet|level range|by level|ranking system|open source|api)\b|приложени|организ|найти игрок|американо|мексикано|расписани|рейтинг/i;

/**
 * Cheap gate before any model call: the text must be about padel and about
 * organising or finding games, tools, levels or formats.
 */
export function looksRelevant(c: Pick<Candidate, "title" | "body">): boolean {
  const text = `${c.title}\n${c.body}`;
  return PADEL.test(text) && INTENT.test(text);
}

/** Language guess for the reply: Cyrillic → ru, Spanish markers → es, else en. */
export function guessLanguage(text: string): "en" | "ru" | "es" {
  if (/[а-яё]/i.test(text)) return "ru";
  if (/\b(el|la|los|las|una|para|con|que|pádel|jugar|partido|pista)\b/i.test(text) && /[áéíóúñ¿¡]/i.test(text)) return "es";
  return "en";
}
