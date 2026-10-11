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

/** A start the viewer may no longer move says why; any other refusal stays the plain one. */
export const editErrorKey = (r: { error: string; detail?: string }): "event.startLocked" | "errors.invalid" =>
  r.error === "forbidden" && r.detail === "startsAt" ? "event.startLocked" : "errors.invalid";
