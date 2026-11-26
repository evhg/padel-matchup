import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, tiktokKeys } from "@/lib/config";
import { matchReelByCode } from "@/lib/domain/matchReel";
import { needsReconnect, notReady, readPostForm, videoPath, type TikTokError } from "@/lib/domain/tiktok";
import { creatorInfo, initPost } from "@/lib/tiktok/api";
import { openToken, TOKEN_COOKIE, videoTicket } from "@/lib/tiktok/seal";
import { sameOrigin } from "@/lib/tiktok/origin";

export const dynamic = "force-dynamic";

/**
 * The player pressed Post: `POST /api/tiktok/post` `{ code, title, privacy, allowComment, allowDuet, allowStitch,
 * commercial, yourBrand, branded, durationSec }`, with the TikTok cookie. This is the first request that sends
 * anything to TikTok about the post (Content Sharing Guidelines: nothing before Post).
 *
 * The form is checked against the creator's account as it is now (creator info again, one call): the privacy
 * must be one of the account's own options, commercial content needs a choice, branded content is never
 * private, and an interaction the account turns off goes off. Then Direct Post with `PULL_FROM_URL`: TikTok
 * pulls the reel from `/api/tiktok/video/<code>.mp4?t=<ticket for one hour>` on our verified prefix.
 * Answers `{ ok, publishId }`, or `{ ok: false, error: { code, message }, reconnect }` with TikTok's own words.
 */
export async function POST(req: NextRequest) {
  const refuse = (error: TikTokError, status = 400) => NextResponse.json({ ok: false, error, reconnect: needsReconnect(error) }, { status });
  if (!tiktokKeys()) return refuse({ code: "off", message: "" }, 404);
  if (!sameOrigin(req)) return refuse({ code: "forbidden", message: "" }, 403);
  const now = new Date();
  const token = openToken(req.cookies.get(TOKEN_COOKIE)?.value, now);
  if (!token) return refuse({ code: "access_token_invalid", message: "" }, 401);
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  const read = readPostForm(body);
  if (!isValidShareCode(code) || !read) return refuse({ code: "bad_request", message: "" });
  const db = await getDb();
  if (!(await matchReelByCode(db, code, now).catch(() => null))) return refuse({ code: "no_reel", message: "" }, 404);
  const info = await creatorInfo(token.accessToken);
  if (!info.ok) return refuse(info.error, 409);
  const why = notReady(info.creator, read.form, read.durationSec);
  if (why) return refuse({ code: why, message: "" });
  const videoUrl = `${baseUrl()}${videoPath(code, videoTicket(code, now))}`;
  const got = await initPost(token.accessToken, info.creator, read.form, videoUrl);
  if (!got.ok) return refuse(got.error, 409);
  return NextResponse.json({ ok: true, publishId: got.publishId });
}
