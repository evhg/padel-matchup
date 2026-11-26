import { NextResponse, type NextRequest } from "next/server";
import { tiktokKeys } from "@/lib/config";
import { isPublishId, needsReconnect, type TikTokError } from "@/lib/domain/tiktok";
import { postStatus } from "@/lib/tiktok/api";
import { openToken, TOKEN_COOKIE } from "@/lib/tiktok/seal";
import { sameOrigin } from "@/lib/tiktok/origin";

export const dynamic = "force-dynamic";

/**
 * Where a post stands: `POST /api/tiktok/status` `{ publishId }`, with the TikTok cookie. The posting page asks
 * every 5 seconds at most and stops at done or failed (`STATUS_EVERY_MS`, `STATUS_STOP_MS`).
 * Answers `{ ok, status: { state: "working" | "done" | "failed", reason? } }` or TikTok's refusal.
 */
export async function POST(req: NextRequest) {
  const refuse = (error: TikTokError, status = 400) => NextResponse.json({ ok: false, error, reconnect: needsReconnect(error) }, { status });
  if (!tiktokKeys()) return refuse({ code: "off", message: "" }, 404);
  if (!sameOrigin(req)) return refuse({ code: "forbidden", message: "" }, 403);
  const token = openToken(req.cookies.get(TOKEN_COOKIE)?.value, new Date());
  if (!token) return refuse({ code: "access_token_invalid", message: "" }, 401);
  const body = (await req.json().catch(() => null)) as { publishId?: unknown } | null;
  if (!isPublishId(body?.publishId)) return refuse({ code: "bad_request", message: "" });
  const got = await postStatus(token.accessToken, body.publishId);
  if (!got.ok) return refuse(got.error, 409);
  return NextResponse.json({ ok: true, status: got.status });
}
