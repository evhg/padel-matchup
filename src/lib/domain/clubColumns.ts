import { getTableColumns } from "drizzle-orm";
import { clubs, type Club } from "@/db/schema";

/**
 * Every column of `clubs` but the cache of free courts (`availability`: up to three days of slots from
 * a platform, the one large column). A leaf, so the booking module and the domain read it without a
 * cycle. Every read of a club takes this unless its page renders free times (AGENTS.md rule 12).
 */
export const columnsButCache = (() => {
  const { availability, ...rest } = getTableColumns(clubs);
  void availability;
  return rest;
})();

/** A club without its cache of free courts. */
export type PickableClub = Omit<Club, "availability">;
