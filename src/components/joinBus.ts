/**
 * Tiny in-page bus: the fixed Join button asks an in-flow "join here" spot (an open roster row, or the
 * waitlist card) to expand and take focus, or to send the form the player already opened.
 * No overlays: on iOS a fixed sheet plus the keyboard drifts off screen.
 */
type Handler = () => void;
/**
 * What a spot holds now: `filled` its form is open with a name in it (or asks no name, only a level),
 * `open` its form is open and empty, `closed` no form on screen.
 */
export type SpotState = "filled" | "open" | "closed";
type Entry = { run: Handler; state: () => SpotState };
const entries: Entry[] = [];

export function registerJoinHandler(run: Handler, state: () => SpotState = () => "closed"): () => void {
  const e: Entry = { run, state };
  entries.push(e);
  return () => {
    const i = entries.indexOf(e);
    if (i >= 0) entries.splice(i, 1);
  };
}

/**
 * Returns false when nothing in flow can take the request (caller falls back). The spot the player
 * opened goes first, the one with a name in it before an empty one: a name typed in the second open row
 * is sent from there, never answered by a second, empty form in the first row (review, 15 October
 * 2026). With no form open, the first spot opens.
 */
export function requestJoin(): boolean {
  const e = entries.find((x) => x.state() === "filled") ?? entries.find((x) => x.state() === "open") ?? entries[0];
  if (!e) return false;
  e.run();
  return true;
}

/** The state of a spot from its form and its name field (null where the form asks no name). */
export function formState(form: HTMLFormElement | null, name: HTMLInputElement | null): SpotState {
  if (!form) return "closed";
  return !name || name.value.trim() ? "filled" : "open";
}

/**
 * Sends an open form the way its own submit button does, through every check its `onSubmit` makes (the
 * name, the held place, the level). A click on that button, never the form's `requestSubmit`: Safari before
 * 16 (iOS 15, the last an iPhone 6s, 7 or first SE gets) has no `requestSubmit`, and the tap would throw.
 * A disabled button (the form is busy) ignores the click, so a second tap sends nothing more. False when
 * the form has no submit button.
 */
export function sendForm(form: HTMLFormElement | null): boolean {
  const b = form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!b) return false;
  b.click();
  return true;
}
