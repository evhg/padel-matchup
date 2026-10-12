/**
 * The second tiny in-page bus, beside `joinBus`.
 *
 * Somebody typing a name that is already in this match is probably that person on a device the page
 * has never seen. The join row cannot show the way back in itself — that block lives further down
 * the page, is rendered on the server and holds both channels. So the join row asks, and the fold
 * opens itself and takes the screen.
 */
type Handler = () => void;
const handlers: Handler[] = [];
/** Set by `requestBackInSoon` while the help it asks for is still on its way: the join form opens on the tap, and its help mounts a moment later. */
let wanted = false;
/** Whoever shows something only while no way back in is on the page ("Played before? Sign in"). */
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

export function registerBackInHandler(h: Handler): () => void {
  handlers.push(h);
  changed();
  if (wanted) {
    wanted = false;
    h();
  }
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
    changed();
  };
}

/** Hears when a way back in comes onto the page or leaves it (`useSyncExternalStore` with `canAskBackIn`). */
export function subscribeBackIn(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** False when this page has no way back in on it, so the caller can stay quiet rather than offer nothing. */
export function requestBackIn(): boolean {
  const h = handlers[0];
  if (!h) return false;
  h();
  return true;
}

/** True when the page carries the fold at all: email and Telegram can both be off (rule 4). */
export const canAskBackIn = (): boolean => handlers.length > 0;

/** The way back in, now when it is on the page, else as soon as it mounts: "Played before? Sign in" opens the join form first, which then mounts the help. */
export function requestBackInSoon(): void {
  if (!requestBackIn()) wanted = true;
}
