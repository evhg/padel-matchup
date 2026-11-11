/**
 * What the "Edit match" form (`src/components/EditMatch.tsx`) sends about the start, and what it says
 * when a save is refused. Pure, so the browser and the tests share it.
 */

export type StartFields = { date: string; time: string; tz: string };

/**
 * The day, the time and the zone go only when one of them changed, as the capacity does. The form shows
 * minutes, so the shown time sent back could move a start with seconds, or one in an hour the clocks
 * repeat, and a note-only edit would count as a move (`mayMoveStart` refuses one after the start).
 */
export function startToSend(values: StartFields, initial: StartFields): Partial<StartFields> {
  const moved = values.date !== initial.date || values.time !== initial.time || values.tz !== initial.tz;
  return moved ? { date: values.date, time: values.time, tz: values.tz } : {};
}

/**
 * The day, the time and the zone the form shows and sends. A viewer who may not move the start
 * (`startLocked`) gets the page's own, never what the form held: the form keeps its values from the
 * first render, and the page renders again under it (a live night every 20 seconds, the page after a
 * save). After the organiser corrects the start, the old values would go back as a move, meet the guard,
 * and leave the player unable to save a note behind fields they cannot change.
 */
export function shownStart<T extends StartFields>(values: T, initial: StartFields, locked: boolean): T {
  return locked ? { ...values, date: initial.date, time: initial.time, tz: initial.tz } : values;
}

/**
 * A refused edit says why where the reason is known: a start the viewer may no longer move, a field
 * only the organiser changes (`organiserOnly`: a player sent more than `PLAYER_EDIT_FIELDS`), a match
 * called off meanwhile, and a tournament made smaller than the players already on its list
 * (`capacity_in_use` in `updateEvent`). Any other refusal stays the plain one.
 */
export const editErrorKey = (r: { error: string; detail?: string }): EditErrorKey =>
  r.error === "forbidden" && r.detail === "startsAt"
    ? "event.startLocked"
    : r.error === "forbidden" && r.detail === "organiserOnly"
      ? "event.organiserOnly"
      : r.error === "cancelled"
        ? "errors.cancelled"
        : r.error === "invalid" && r.detail === "capacity_in_use"
          ? "creator.editCapacityInUse"
          : "errors.invalid";

/** The fields of the "Edit match" form that the action takes, beside the start and the capacity. */
export type EditFields = StartFields & {
  type: "match" | "tournament";
  title: string;
  durationMinutes: number;
  venueName: string;
  venueMapUrl: string;
  court: string;
  note: string;
  whenFull: "waitlist" | "closed";
  capacity: number;
  levelMin: number | null;
  levelMax: number | null;
  levelVerifiedOnly: boolean;
  category: string | null;
  ageMin: number | null;
  publicListing: boolean;
  bookingUrl: string;
  cost: string;
  payNote: string;
};

/** Each of these goes only when the person changed it in the form. */
const OWN_FIELDS = ["title", "durationMinutes", "venueName", "venueMapUrl", "court", "note", "whenFull", "levelVerifiedOnly", "category", "ageMin", "publicListing", "bookingUrl", "cost", "payNote"] as const;

type OwnField = (typeof OWN_FIELDS)[number];
export type EditPatch<T extends EditFields> = Partial<Pick<T, OwnField | "levelMin" | "levelMax" | "capacity">> & Partial<StartFields>;

/**
 * What a save sends: only the fields the person changed since the form opened (`opened`, the page's
 * values at that moment), never the whole form. The form used to send every field as it was when the
 * page first loaded (review of 9 November 2026): a note-only save took the match off the venue board
 * after "Show on the board", put back a venue a player had changed meanwhile, and shrank a tournament
 * that a walk-in had grown. A field nobody touched stays as the server holds it now.
 *
 * The range goes as a pair, as the server reads it (`normalizeRange`). The capacity is a tournament's
 * only. `locked`: this viewer may not move the start (`mayMoveStart`), so no start goes at all.
 */
export function editPatch<T extends EditFields>(values: T, opened: T, locked: boolean): EditPatch<T> {
  const out: Record<string, unknown> = {};
  for (const k of OWN_FIELDS) if (values[k] !== opened[k]) out[k] = values[k];
  if (values.levelMin !== opened.levelMin || values.levelMax !== opened.levelMax) {
    out.levelMin = values.levelMin;
    out.levelMax = values.levelMax;
  }
  if (values.type === "tournament" && values.capacity !== opened.capacity) out.capacity = values.capacity;
  return { ...(out as EditPatch<T>), ...(locked ? {} : startToSend(values, opened)) };
}

/** The keys a refused edit can show (`editErrorKey`). */
export type EditErrorKey = "event.startLocked" | "event.organiserOnly" | "errors.invalid" | "errors.cancelled" | "creator.editCapacityInUse";

/** The booking link field held a text with no link (`bookingLinkOf`): the create and the edit form say so under that field. */
export const noBookingLink = (r: { error: string; detail?: string }): boolean => r.error === "invalid" && r.detail === "bookingUrl";
