import { NextResponse } from "next/server";
import { passportKeys } from "@/lib/config";
import { readReelReport } from "@/lib/domain/matchReel";
import { postMatchReel } from "@/lib/api/matchReelPost";

export const dynamic = "force-dynamic";

/**
 * The fast reel's job reports here (`scripts/highlights/modal/fastreel.py`), with the report key Kicksmash signed
 * for the codes of its upload (`signReelReport`, in the answer to the reel host). The same bodies as
 * `/api/admin/match-reel`'s POST: its progress, or the finished reel. The key opens the codes it names, for three
 * days, and nothing else; it is checked before the body is read for anything but its code. No operator secret
 * lives on the reel host.
 */
export async function POST(req: Request) {
  const keys = passportKeys();
  const key = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const codes = keys ? await readReelReport(key, keys.pub, new Date()) : null;
  if (!codes) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof body?.code !== "string" || !codes.includes(body.code)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return postMatchReel(body);
}
