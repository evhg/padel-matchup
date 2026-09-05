import { sql } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { dayKey } from "./metrics";

/**
 * Fixed-window counters on metrics_daily (no extra infrastructure). Windows
 * are UTC days or UTC hours. Returns true while under the limit.
 */
export async function takeRate(db: Db, scope: string, id: string, limit: number, window: "day" | "hour" = "day", now = new Date()): Promise<boolean> {
  const key = window === "hour" ? `rl:${scope}:${id}:h${now.getUTCHours()}` : `rl:${scope}:${id}`;
  const rows = await db
    .insert(metricsDaily)
    .values({ day: dayKey(now), key, value: 1 })
    .onConflictDoUpdate({ target: [metricsDaily.day, metricsDaily.key], set: { value: sql`${metricsDaily.value} + 1` } })
    .returning({ value: metricsDaily.value });
  return Number(rows[0]?.value ?? 0) <= limit;
}

/** Generous ceilings: a human never hits them, a script does within minutes. */
export const LIMITS = {
  newIdentitiesPerIpPerDay: 40,
  eventsPerPlayerPerDay: 20,
  reservesPerOrganizerPerDay: 40,
  joinsPerPlayerPerHour: 30,
  emailChangesPerPlayerPerDay: 10,
  personalLinkMailsPerPlayerPerDay: 5,
  restoreCodesPerIpPerDay: 20,
  clientErrorReportsPerIpPerDay: 60,
  // Public API and MCP: open without a key, roomier with one.
  apiKeysPerIpPerDay: 10,
  apiWritesPerIpPerDay: 12,
  apiWritesPerKeyPerDay: 300,
  apiReadsPerIpPerHour: 600,
  mcpCallsPerIpPerHour: 300,
  webhooksPerKey: 10,
} as const;
