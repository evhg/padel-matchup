import { type NextRequest } from "next/server";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { tiktokKeys } from "@/lib/config";
import { matchReelByCode } from "@/lib/domain/matchReel";
import { codeOfVideoFile } from "@/lib/domain/tiktok";
import { videoTicketOk } from "@/lib/tiktok/seal";

export const dynamic = "force-dynamic";
/**
 * TikTok pulls the reel through this route at up to 100 Mbps: a tall reel of about 80 MB takes at least 7 s at that
 * speed, and longer when the reel host is slower. Five minutes leaves room for a slow pull. A stream that waits on
 * the network counts against the provisioned memory, not the CPU (docs/OPERATING.md).
 */
export const maxDuration = 300;

type Ctx = { params: Promise<{ file: string }> };

/** The headers of the reel host's answer that TikTok needs, and nothing of the host's own. */
function passHeaders(upstream: Response): Headers {
  const h = new Headers({ "content-type": "video/mp4", "accept-ranges": "bytes", "cache-control": "private, no-store", "x-robots-tag": "noindex" });
  for (const name of ["content-length", "content-range"]) {
    const v = upstream.headers.get(name);
    if (v) h.set(name, v);
  }
  return h;
}

/**
 * The tall reel of a match, for TikTok's PULL_FROM_URL: `GET /api/tiktok/video/<code>.mp4?t=<ticket>`.
 *
 * TikTok takes the file only from the URL prefix we verified (https://kicksma.sh/), and a redirect is invalid,
 * so the reel cannot be pulled from the reel host directly: this route streams it through. The ticket
 * (`videoTicket`, one hour, signed for this match) is checked before the database is asked anything. A Range
 * header goes to the reel host as it came, and its 200 or 206 comes back with the length and the range; the
 * body is passed on as it arrives, never held in memory.
 *
 * Scale (AGENTS.md rule 12): each post moves the reel through a function once, about 80 MB of Vercel's 100 GB a
 * month. It is the price of TikTok's rule; no other path calls this route.
 */
async function serve(req: NextRequest, ctx: Ctx, method: "GET" | "HEAD"): Promise<Response> {
  const nothing = (status: number) => new Response(null, { status, headers: { "cache-control": "no-store" } });
  if (!tiktokKeys()) return nothing(404);
  const code = codeOfVideoFile((await ctx.params).file);
  if (!code || !isValidShareCode(code)) return nothing(404);
  const now = new Date();
  if (!videoTicketOk(code, req.nextUrl.searchParams.get("t"), now)) return nothing(403);
  const reel = await matchReelByCode(await getDb(), code, now).catch(() => null);
  if (!reel) return nothing(404);
  const range = req.headers.get("range");
  let upstream: Response;
  try {
    upstream = await fetch(reel.tall, { method, headers: range ? { range } : {}, cache: "no-store", signal: req.signal });
  } catch {
    return nothing(502);
  }
  if (upstream.status === 416) {
    await upstream.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 416, headers: passHeaders(upstream) });
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    await upstream.body?.cancel().catch(() => undefined);
    return nothing(502);
  }
  return new Response(method === "HEAD" ? null : upstream.body, { status: upstream.status, headers: passHeaders(upstream) });
}

export function GET(req: NextRequest, ctx: Ctx) {
  return serve(req, ctx, "GET");
}

export function HEAD(req: NextRequest, ctx: Ctx) {
  return serve(req, ctx, "HEAD");
}
