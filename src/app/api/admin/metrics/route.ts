import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { operatorAuthorized } from "@/lib/api/secret";
import { dayKey, setMetric } from "@/lib/domain/metrics";

export const dynamic = "force-dynamic";

const KEY_RE = /^[a-z][a-z0-9_]{2,60}$/;

/**
 * POST /api/admin/metrics { key, value, day? } → sets one daily metric. Bearer CRON_SECRET.
 * For figures only an outside job can know: the domain's expiry from Porkbun, a billed
 * amount read elsewhere. Keys are lowercase snake_case; values are numbers.
 */
export async function POST(req: Request) {
  if (!(await operatorAuthorized(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { key?: unknown; value?: unknown; day?: unknown } | null;
  const key = typeof body?.key === "string" ? body.key : "";
  const value = typeof body?.value === "number" ? body.value : Number(body?.value);
  const day = typeof body?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : dayKey();
  if (!KEY_RE.test(key)) return NextResponse.json({ error: "key must be lowercase snake_case" }, { status: 400 });
  if (!Number.isFinite(value)) return NextResponse.json({ error: "value must be a number" }, { status: 400 });
  await setMetric(await getDb(), key, value, day);
  return NextResponse.json({ ok: true, key, value, day });
}
