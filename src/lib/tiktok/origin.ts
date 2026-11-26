import { baseUrl } from "@/lib/config";

/**
 * Whether a POST to the TikTok routes comes from our own pages. The token cookie is SameSite=Lax, so another
 * site's form cannot send it; a browser also names the page's origin, and a different one is refused. A request
 * with no Origin header (not a browser) carries no cookie of a player's unless it holds one already.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(baseUrl()).origin;
  } catch {
    return false;
  }
}
