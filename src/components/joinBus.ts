/**
 * Tiny in-page bus: the fixed Join button asks the first in-flow "join here"
 * spot (an open roster row, or the waitlist card) to expand and take focus.
 * No overlays: on iOS a fixed sheet plus the keyboard drifts off screen.
 */
type Handler = () => void;
const handlers: Handler[] = [];

export function registerJoinHandler(h: Handler): () => void {
  handlers.push(h);
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}

/** Returns false when nothing in flow can take the request (caller falls back). */
export function requestJoin(): boolean {
  const h = handlers[0];
  if (!h) return false;
  h();
  return true;
}
