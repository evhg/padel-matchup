import type { Viewport } from "next";

/**
 * A page shown on somebody else's wall or website (the club's TV, the printed poster, the embeds)
 * carries `data-keep-light` and keeps the light colours whatever the phone says (globals.css). The
 * browser's own bar must stay light with it, so these pages set one light theme-color, the light
 * page ground, in place of the root layout's pair. `tests/contrast.test.ts` holds every such page to it.
 */
export const KEEP_LIGHT_VIEWPORT: Viewport = { themeColor: "#f4f3ee" };
