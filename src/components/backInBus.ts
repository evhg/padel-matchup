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

export function registerBackInHandler(h: Handler): () => void {
  handlers.push(h);
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
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
