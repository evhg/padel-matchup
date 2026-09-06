import { getDb } from "@/db";
import { CORS_HEADERS } from "@/lib/api/http";
import { calendarTitle } from "@/lib/calendar";
import { APP_NAME, baseUrl } from "@/lib/config";
import { getEventByCode } from "@/lib/domain/queries";
import { getVenueName } from "@/lib/domain/venueBoard";
import { EMBED_SIZES, embedHtml, parseEmbedTarget } from "@/lib/embed";

export const dynamic = "force-dynamic";

/**
 * oEmbed provider: GET /api/oembed?url=https://kicksma.sh/{code}|/v/{slug}&format=json.
 * Platforms that support oEmbed (WordPress, Discourse, Ghost, Notion) turn a
 * pasted link into the live board or match card.
 */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const format = u.searchParams.get("format") ?? "json";
  if (format !== "json") return Response.json({ error: "Only format=json is supported." }, { status: 501, headers: CORS_HEADERS });
  const target = parseEmbedTarget(u.searchParams.get("url") ?? "", baseUrl());
  if (!target) return Response.json({ error: "url must be a kicksma.sh match or venue board link." }, { status: 404, headers: CORS_HEADERS });
  const db = await getDb();
  const base = baseUrl();
  let title: string | null = null;
  if (target.kind === "match") {
    const detail = await getEventByCode(db, target.code);
    if (detail) title = calendarTitle(detail.event, detail.event.type === "tournament" ? "Padel tournament" : "Padel match");
  } else {
    const venue = await getVenueName(db, target.slug);
    if (venue) title = `Open padel matches at ${venue.name}`;
  }
  if (!title) return Response.json({ error: "Not found." }, { status: 404, headers: CORS_HEADERS });
  const size = EMBED_SIZES[target.kind];
  const maxW = Number(u.searchParams.get("maxwidth"));
  const width = Number.isFinite(maxW) && maxW > 0 ? Math.min(size.width, maxW) : size.width;
  return Response.json(
    {
      version: "1.0",
      type: "rich",
      provider_name: APP_NAME,
      provider_url: base,
      title,
      html: embedHtml(base, target, title).replace(`width="${size.width}"`, `width="${width}"`),
      width,
      height: size.height,
      cache_age: 300,
    },
    { headers: { ...CORS_HEADERS, "cache-control": "public, max-age=300" } },
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
