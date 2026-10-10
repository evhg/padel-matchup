import { and, like, lt, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { dayKey } from "./metrics";

/**
 * Fixed-window counters on metrics_daily (no extra infrastructure). Windows
 * are UTC days or UTC hours. Returns true while under the limit.
 */
export async function takeRate(db: Db, scope: string, id: string, limit: number, window: "day" | "hour" = "day", now = new Date(), by = 1): Promise<boolean> {
  const key = window === "hour" ? `rl:${scope}:${id}:h${now.getUTCHours()}` : `rl:${scope}:${id}`;
  // `by`: several of one thing in one request (a pasted list of names) take their places in one write.
  const rows = await db
    .insert(metricsDaily)
    .values({ day: dayKey(now), key, value: by })
    .onConflictDoUpdate({ target: [metricsDaily.day, metricsDaily.key], set: { value: sql`${metricsDaily.value} + ${by}` } })
    .returning({ value: metricsDaily.value });
  return Number(rows[0]?.value ?? 0) <= limit;
}

/** How many days a rate-limit row is kept. A limit only ever reads today's row; the rest is history nobody reads. */
export const RATE_ROWS_KEEP_DAYS = 2;

/**
 * Deletes the rate-limit rows (`rl:` keys) older than RATE_ROWS_KEEP_DAYS. The owner decided on 30
 * September 2026 (option A) that these rows are hashed (`src/lib/ipKey.ts`) and short-lived: about 200
 * are written a day, and none is read after its day or hour. Runs on the hourly job; the delete walks
 * the table's primary key by day. Returns how many rows went.
 */
export async function pruneRateRows(db: Db, now = new Date()): Promise<number> {
  const cutoff = dayKey(new Date(now.getTime() - RATE_ROWS_KEEP_DAYS * 24 * 60 * 60 * 1000));
  const gone = await db
    .delete(metricsDaily)
    .where(and(lt(metricsDaily.day, cutoff), like(metricsDaily.key, "rl:%")))
    .returning({ key: metricsDaily.key });
  return gone.length;
}

/** Generous ceilings: a human never hits them, a script does within minutes. */
export const LIMITS = {
  newIdentitiesPerIpPerDay: 40,
  eventsPerPlayerPerDay: 20,
  reservesPerOrganizerPerDay: 40,
  joinsPerPlayerPerHour: 30,
  emailChangesPerPlayerPerDay: 10,
  personalLinkMailsPerPlayerPerDay: 5,
  inviteResendsPerPlayerPerDay: 6,
  /** "Confirm my level" asks a player may send in a day (coaches and clubs together). */
  levelChecksPerPlayerPerDay: 6,
  /** Notices of new asks to join that one group's admins hear in a day; past it the asks wait on the group page, unannounced. */
  groupAskNoticesPerGroupPerDay: 10,
  restoreCodesPerIpPerDay: 20,
  /**
   * "That's me" taps from one address in a day, refused ones too: a name is tried, never guessed in a
   * loop (DECIDING rule 32). Twenty, not ten: a club's Wi-Fi is one address for every player on it.
   */
  thatsMePerIpPerDay: 20,
  /** Sign-ins by name into one record in a day, from anywhere: a record is not taken over and over. */
  thatsMePerRecordPerDay: 3,
  clientErrorReportsPerIpPerDay: 60,
  feedbackPerIpPerDay: 5,
  // Public API and MCP: open without a key, roomier with one.
  apiKeysPerIpPerDay: 10,
  apiWritesPerIpPerDay: 12,
  apiWritesPerKeyPerDay: 300,
  apiReadsPerIpPerHour: 600,
  mcpCallsPerIpPerHour: 300,
  webhooksPerKey: 10,
} as const;
