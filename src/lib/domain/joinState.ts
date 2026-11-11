/**
 * What the match page's join bar offers this viewer (`JoinBar`). Pure, so the ladder is a table in
 * `tests/join-state.test.ts`; the page reads every fact once and asks this.
 *
 * `waitlist_live`: a place on the waiting list once the match has started. `leaveEvent` refuses every
 * leave after the start (`past`), so "Leave waitlist" there failed on every tap and said "This match has
 * already happened" while it was still on (review, 9 November 2026). The bar now says where the player
 * stands and offers nothing, as a seat does once the match is on (`member_live`).
 */
export type JoinState = "join" | "join_waitlist" | "leave" | "leave_waitlist" | "waitlist_live" | "member_live" | "full" | "cancelled" | "past" | "requested" | "request_declined";

export function joinStateOf(o: {
  cancelled: boolean;
  over: boolean;
  started: boolean;
  /** A taken seat on the line-up. */
  member: boolean;
  /** A taken place on the waiting list. */
  waitlisted: boolean;
  /** A place the organiser holds for this very record: Join takes it. */
  held: boolean;
  request: "pending" | "declined" | null;
  spotsLeft: number;
  whenFull: "waitlist" | "closed";
}): JoinState {
  if (o.cancelled) return "cancelled";
  if (o.over) return "past";
  if (o.member) return o.started ? "member_live" : "leave";
  if (o.waitlisted) return o.started ? "waitlist_live" : "leave_waitlist";
  if (o.held) return "join";
  if (o.request === "pending") return "requested";
  if (o.request === "declined") return "request_declined";
  if (o.spotsLeft > 0) return "join";
  return o.whenFull === "waitlist" ? "join_waitlist" : "full";
}
