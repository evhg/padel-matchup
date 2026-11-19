/**
 * The screen a note came from, as the path of that screen with its secrets taken out.
 *
 * A note keeps its screen so the person who reads it knows where to look. Five routes carry a key in the path
 * (a personal link, an invitation, two manage links), and a key in a row of notes is a way into somebody's
 * account for everybody who can read that row. So the key becomes the name of its route segment.
 * A query string and a fragment never belong to a screen.
 */
const SECRETS: [RegExp, string][] = [
  [/^\/p\/[^/]+/, "/p/[token]"],
  [/^(\/[^/]+\/i)\/[^/]+/, "$1/[invite]"],
  [/^(\/[^/]+\/manage)\/[^/]+/, "$1/[manage]"],
  [/^(\/v\/[^/]+\/manage)\/[^/]+/, "$1/[token]"],
];

export function screenOf(path: string | null | undefined): string | null {
  if (!path || !path.startsWith("/") || path.startsWith("//")) return null;
  let screen = path.split(/[?#]/)[0]!;
  for (const [secret, name] of SECRETS) screen = screen.replace(secret, name);
  return screen.slice(0, 200);
}
