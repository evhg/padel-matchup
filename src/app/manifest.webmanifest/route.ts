import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { APP_NAME, APP_TAGLINE, baseUrl } from "@/lib/config";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { personalPath } from "@/lib/personal";
import { getSessionPlayerId } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Web app manifest, personalised per visitor: the home-screen shortcut opens
 * the player's personal link, which signs them in even in the separate
 * cookie jar iOS uses for home-screen apps.
 */
export async function GET() {
  let startUrl = "/?source=homescreen";
  try {
    const playerId = await getSessionPlayerId();
    if (playerId) {
      const db = await getDb();
      startUrl = `${personalPath(await getOrCreatePersonalToken(db, playerId))}?source=homescreen`;
    }
  } catch (e) {
    console.warn("[manifest] falling back to anonymous start_url", e);
  }
  const manifest = {
    name: APP_NAME,
    short_name: APP_NAME,
    description: APP_TAGLINE,
    id: "/",
    start_url: startUrl,
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#f4f3ee",
    theme_color: "#f4f3ee",
    // Lets Android Chrome answer navigator.getInstalledRelatedApps() for this very PWA.
    related_applications: [{ platform: "webapp", url: `${baseUrl()}/manifest.webmanifest` }],
    icons: [
      { src: "/api/icon?size=192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/api/icon?size=512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/api/icon?size=512&maskable=1", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
  return NextResponse.json(manifest, {
    headers: { "Content-Type": "application/manifest+json", "Cache-Control": "private, no-store" },
  });
}
