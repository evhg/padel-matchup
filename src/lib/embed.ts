import { isValidShareCode } from "@/lib/codes";
import { isValidVenueSlug } from "@/lib/domain/venueBoard";

/**
 * Embeds: a board or a match as an iframe anyone may drop into a club site,
 * a blog or a forum post. oEmbed lets platforms that support it (WordPress,
 * Discourse, Notion, Ghost) do that from the plain URL.
 */
export type EmbedTarget = { kind: "board"; slug: string } | { kind: "match"; code: string };

export const EMBED_SIZES = { board: { width: 420, height: 520 }, match: { width: 420, height: 380 } } as const;

/** Recognises kicksma.sh/{code}, /v/{slug} and the /embed/… forms themselves. Null for anything else. */
export function parseEmbedTarget(rawUrl: string, base: string): EmbedTarget | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = new URL(base).host;
  if (u.host !== host && u.host !== "kicksma.sh") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length === 1 && isValidShareCode(parts[0])) return { kind: "match", code: parts[0] };
  if (parts.length >= 2 && parts[0] === "v" && isValidVenueSlug(parts[1])) return { kind: "board", slug: parts[1] };
  if (parts.length === 3 && parts[0] === "embed" && parts[1] === "match" && isValidShareCode(parts[2])) return { kind: "match", code: parts[2] };
  if (parts.length === 3 && parts[0] === "embed" && parts[1] === "board" && isValidVenueSlug(parts[2])) return { kind: "board", slug: parts[2] };
  return null;
}

export const embedPath = (t: EmbedTarget) => (t.kind === "board" ? `/embed/board/${t.slug}` : `/embed/match/${t.code}`);

export function embedHtml(base: string, t: EmbedTarget, title: string): string {
  const size = EMBED_SIZES[t.kind];
  const src = `${base}${embedPath(t)}`;
  const safeTitle = title.replace(/[<>"&]/g, "");
  return `<iframe src="${src}" title="${safeTitle}" width="${size.width}" height="${size.height}" style="max-width:100%;border:0;border-radius:16px" loading="lazy" allowtransparency="true"></iframe>`;
}
