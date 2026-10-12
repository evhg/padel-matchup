import type { Db } from "@/db";
import { later } from "@/lib/alerts";
import { countMerge, type MergeCounter } from "@/lib/domain/signins";

/**
 * A merge's count (`merge_<door>`, `countMerge`), written after the answer (`later`), as `countSignIn`
 * is, never in the path a person waits on. Every door that can fold two records hands this to the
 * domain call that folds them; outside a request `later` writes it at once.
 */
export const mergesLater =
  (db: Db): MergeCounter =>
  (door, records) =>
    later(() => countMerge(db, door, records));
