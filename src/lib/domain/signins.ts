import type { Db } from "@/db";
import { browserClass } from "./browserClass";
import { nameIsHere } from "./dupes";
import { bumpMetric } from "./metrics";

/**
 * How a browser came to be signed in, counted per day with nothing personal (docs/OPERATING.md).
 *
 * The owner's second pain (10 October 2026) is a player asked who they are on every tap from a
 * WhatsApp group. Each way back in is a door, and a door nobody uses is a door to redesign, so each
 * one counts itself the moment it sets the cookie in a browser that held another identity or none:
 *
 *   - `thats_me`: "That's me" on a match page, by name, without proof (DECIDING rule 32);
 *     `thats_me_fold` as well when it folded the new record this browser had made into the old one.
 *   - `restore`: the browser's own saved id brought back without proof (`restoreIdentity`).
 *   - `personal_link`: the personal link, on any of its three paths.
 *   - `email_code`: a six-digit code that came back from the address.
 *   - `telegram`: the Telegram login widget; `telegram_miniapp`: the Mini App inside Telegram.
 *
 * A link of a second channel to a browser already signed in is not a sign-in and is not counted.
 */
export const SIGNIN_WAYS = ["thats_me", "thats_me_fold", "restore", "personal_link", "email_code", "telegram", "telegram_miniapp"] as const;
export type SignInWay = (typeof SIGNIN_WAYS)[number];

/** Never throws: a sign-in must not fail because its counter did. */
export async function countSignIn(db: Db, way: SignInWay): Promise<void> {
  await bumpMetric(db, `signin_${way}`).catch(() => undefined);
}

/**
 * A record made from a name alone: a browser that has never seen this person. What can be known about
 * that browser is counted, and nothing personal is kept (docs/OPERATING.md):
 *
 *   - `newid_ua_<class>`: which kind of browser, from its user agent (`browserClass`);
 *   - `newid_src_<tag>`: the tag of the link it came through, when it had one (`?s=wa` from WhatsApp);
 *   - `newid_name_here`: the name it took is already in the match it joined, which most likely means
 *     somebody who has played here before, in a browser that does not know them.
 *
 * Never throws: a join must not fail because a counter did.
 */
export async function countNewRecord(db: Db, o: { ua: string | null | undefined; source: string | null; name: string; namesHere?: readonly (string | null | undefined)[] }): Promise<void> {
  try {
    await bumpMetric(db, `newid_ua_${browserClass(o.ua)}`);
    if (o.source) await bumpMetric(db, `newid_src_${o.source}`);
    if (o.namesHere && nameIsHere(o.name, o.namesHere)) await bumpMetric(db, "newid_name_here");
  } catch {
    /* counters are optional */
  }
}
