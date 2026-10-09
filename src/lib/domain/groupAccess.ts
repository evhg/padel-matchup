/**
 * Who sees what on a group, and what a join does to it. Pure: no database, no clock of its own.
 *
 * The owner's decision E, 9 October 2026: "names visible, levels hidden, optional Ask to join". A
 * visitor sees a crew's first names and how many they are — that is the social proof — and never a
 * member's level, which is a person's own data. A group may switch on "Ask to join" (a ladies' crew,
 * a level crew): new people ask and an admin says yes.
 *
 * The group's own level range is not hidden by any of this. It says what level the crew plays, which
 * is the group describing itself, not a person.
 */

/** How far the viewer is inside the group: their member row's role, or nothing for a visitor. */
export type GroupViewer = { role: "admin" | "member" } | null | undefined;

/**
 * May this viewer see the members' levels (and anything built on them)? Members and admins yes;
 * a visitor, a signed-out reader, the public API, the MCP server and a search engine no. A caller
 * with no viewer at all (the API's anonymous read) passes null, so the safe answer is the default.
 */
export function canSeeMemberLevels(viewer: GroupViewer): boolean {
  return viewer?.role === "admin" || viewer?.role === "member";
}

/** A member as the viewer may see them: the level dropped unless `canSeeMemberLevels`. */
export function memberLevelFor(level: number | null, viewer: GroupViewer): number | null {
  return canSeeMemberLevels(viewer) ? level : null;
}

/**
 * Who is acting when somebody becomes a member.
 *   - `self`: the person taps Join (or Ask to join) on the group page.
 *   - `match`: a seat in one of the group's matches — the web, the chats, the API, an invite, an
 *     approved level request, a confirmed level. The seat follows the match's own rules.
 *   - `admin`: an admin adds or approves.
 */
export type JoinVia = "self" | "match" | "admin";

/**
 * What a join does. With "Ask to join" off it adds, for every caller, exactly as before decision E.
 * With it on, only an admin adds; the person's own tap becomes an ask; a match seat adds nobody,
 * so joining a crew's match never makes you part of a crew that asks first.
 */
export function joinDoor(group: { askToJoin: boolean }, via: JoinVia): "add" | "ask" | "none" {
  if (!group.askToJoin || via === "admin") return "add";
  return via === "self" ? "ask" : "none";
}

/** A declined person may ask again this many days after the decision. */
export const ASK_AGAIN_DAYS = 7;
/** A reopened ask tells the admins again only when the last one is at least this old, so ask, withdraw, ask is one notice. */
export const ASK_NOTICE_GAP_MS = 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;

export type AskRow = { status: "pending" | "approved" | "declined" | "withdrawn"; createdAt: Date; decidedAt: Date | null };

export type AskStep =
  /** No row yet: insert one, and tell the admins. */
  | { kind: "insert"; notify: true }
  /** A withdrawn, approved-then-left or declined-long-ago row goes back to pending. */
  | { kind: "reopen"; notify: boolean }
  /** Already waiting: nothing changes and nobody hears twice. */
  | { kind: "keep"; notify: false }
  /** Declined less than ASK_AGAIN_DAYS ago: nothing changes until `from`. */
  | { kind: "wait"; notify: false; from: Date };

/** The next step for a person who asks to join, given their row for that group (or none). */
export function nextAsk(existing: AskRow | null | undefined, now: Date): AskStep {
  if (!existing) return { kind: "insert", notify: true };
  if (existing.status === "pending") return { kind: "keep", notify: false };
  if (existing.status === "declined") {
    const from = askAgainFrom(existing);
    if (from && from.getTime() > now.getTime()) return { kind: "wait", notify: false, from };
  }
  return { kind: "reopen", notify: now.getTime() - existing.createdAt.getTime() >= ASK_NOTICE_GAP_MS };
}

/** When a declined person may ask again: seven days after the decision. Null for any other row. */
export function askAgainFrom(row: Pick<AskRow, "status" | "decidedAt">): Date | null {
  if (row.status !== "declined" || !row.decidedAt) return null;
  return new Date(row.decidedAt.getTime() + ASK_AGAIN_DAYS * DAY_MS);
}

export const ASK_NOTE_MAX = 200;

/**
 * The note an asker leaves for the admins: control characters and runs of space become one space,
 * trimmed, at most 200 characters (counted as a person counts them, so an emoji is never cut in
 * half). Empty is null.
 */
export function cleanAskNote(v: string | null | undefined): string | null {
  const flat = (v ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = Array.from(flat).slice(0, ASK_NOTE_MAX).join("").trim();
  return cut || null;
}
