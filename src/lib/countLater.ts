import "server-only";
import { cache } from "react";
import type { Db } from "@/db";
import { bumpMetrics } from "@/lib/domain/metrics";
import { later } from "@/lib/later";

/**
 * The counters of one page render, written after the answer in one statement (`bumpMetrics`). The root
 * layout counts the page view and the match page counts who viewed it; each hands its keys here, and
 * one upsert carries them all once the answer has gone, never in the path a person waits on.
 *
 * React's `cache` keeps one bag for each render. Outside a render (a server action, a route, a test)
 * each call gets a bag of its own, so its keys go in a statement of their own. A call after the bag was
 * written starts a new one, so no key is ever dropped.
 */
const bagOf = cache((): { keys: string[]; pending: boolean } => ({ keys: [], pending: false }));

export async function countAfter(db: Db, keys: readonly string[]): Promise<void> {
  if (keys.length === 0) return;
  const bag = bagOf();
  bag.keys.push(...keys);
  if (bag.pending) return;
  bag.pending = true;
  await later(async () => {
    bag.pending = false;
    await bumpMetrics(db, bag.keys.splice(0));
  });
}
