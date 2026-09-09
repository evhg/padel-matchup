import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { tavilyUsage } from "./tavily";

/**
 * The free plan is a thousand credits a month. They are spent evenly across the
 * month (so nothing is left over and nothing runs out early), a few are kept for
 * research by hand, and the last five are never touched.
 */
export const PLAN = { credits: 1000, reserve: 60, perTick: 12, hardStop: 5 } as const;

export function cycleOf(now: Date) {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsed = Math.min(1, Math.max(0, (now.getTime() - start) / (end - start)));
  return { start: new Date(start), end: new Date(end), elapsed, daysLeft: Math.max(0, Math.ceil((end - now.getTime()) / 86_400_000)) };
}

/** Credits the even pace allows to have been spent by this moment. */
export const pacedTarget = (now: Date, limit: number = PLAN.credits, reserve: number = PLAN.reserve) => Math.floor(Math.max(0, limit - reserve) * cycleOf(now).elapsed);

/** What one hourly run may spend: catch up to the pace, never past the hard stop, never more than a handful. */
export const allowance = (used: number, now: Date, limit: number = PLAN.credits) => Math.max(0, Math.min(PLAN.perTick, pacedTarget(now, limit) - used, limit - PLAN.hardStop - used));

/** Research by hand draws on the reserve: allowed until the hard stop. */
export const canSpendByHand = (used: number, credits: number, limit: number = PLAN.credits) => used + credits <= limit - PLAN.hardStop;

export type Meter = { used: number; limit: number; source: "tavily" | "counter" };

/** Tavily's meter when it answers (remembered for the board), our own counter for the month otherwise. */
export async function readMeter(db: Db, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<Meter> {
  const u = await tavilyUsage(fetchImpl);
  const day = dayKey(now);
  if (u) {
    await setMetric(db, "tavily_plan_used", u.used, day);
    await setMetric(db, "tavily_plan_limit", u.limit, day);
    return { used: u.used, limit: u.limit, source: "tavily" };
  }
  const since = dayKey(cycleOf(now).start);
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${metricsDaily.value}), 0)` })
    .from(metricsDaily)
    .where(and(eq(metricsDaily.key, "tavily_calls"), gte(metricsDaily.day, since)));
  return { used: Number(row?.n ?? 0), limit: PLAN.credits, source: "counter" };
}
