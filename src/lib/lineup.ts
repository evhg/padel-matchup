import type { Slot } from "@/db/schema";

/** Every roster spot is taken by a joined/confirmed player (no holes, no pending invites). */
export function lineupComplete(roster: Pick<Slot, "status" | "position">[], capacity: number): boolean {
  const spots = roster.filter((s) => s.position <= capacity);
  return spots.length >= capacity && spots.every((s) => s.status === "joined" || s.status === "confirmed");
}

/** Calendar title once the line-up is complete: "Thursday padel · Club · Court 3 - COMPLETE". */
export function withCompleteSuffix(title: string, complete: boolean, suffix: string): string {
  return complete ? `${title} - ${suffix}` : title;
}
