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
 *   - `thats_me`: "That's me" on a match page, by name, without proof (DECIDING rule 34);
 *     `thats_me_fold` as well when it folded the new record this browser had made into the old one.
 *   - `held_link`: the personal link of a held place that keeps a past player's record, in a browser
 *     that knew nobody; marked by name, as "That's me" is (the owner, 11 October 2026).
 *   - `restore`: a lost cookie brought back from the seal the browser kept (`restoreIdentity`). The
 *     person proves nothing; the browser gives back what the server signed for it. Until 11 October
 *     2026 it took a bare player id, which anybody could read off a match page.
 *   - `personal_link`: the personal link, on any of its three paths.
 *   - `email_code`: a six-digit code that came back from the address.
 *   - `telegram`: the Telegram login widget; `telegram_miniapp`: the Mini App inside Telegram.
 *
 * A link of a second channel to a browser already signed in is not a sign-in and is not counted.
 */
export const SIGNIN_WAYS = ["thats_me", "thats_me_fold", "held_link", "restore", "personal_link", "email_code", "telegram", "telegram_miniapp"] as const;
export type SignInWay = (typeof SIGNIN_WAYS)[number];

/** Never throws: a sign-in must not fail because its counter did. */
export async function countSignIn(db: Db, way: SignInWay): Promise<void> {
  await bumpMetric(db, `signin_${way}`).catch(() => undefined);
}

/**
 * Two records found to be one person, folded into one (`mergePlayers`), counted per day by the door
 * that folded them, as `merge_<door>`, with the number of records that went: the owner cannot see how
 * often a person ends up with two records, and each door is a different cause. Nothing personal is kept.
 *
 *   - `operator`: the operator's own merge (`POST /api/admin/merge-players`).
 *   - `email_code`: a code that came back from an address folds every record of that address, and the
 *     browser's own (`restoreByEmail`).
 *   - `same_name`: at that proof (an email code, Telegram, a WhatsApp number linked), the rows of the
 *     same name nobody can reach that share a match, an organiser or a club (`foldSameNameRows`).
 *   - `same_name_claim`: "These are mine" on My matches (`claimSameNameRow`).
 *   - `claim`: a competition partner's claim link folds the placeholder entered by name (`claimPartnerSpot`).
 *   - `thats_me`: "That's me" folds the browser's own new record into the old one (`commitThatsMe`).
 *   - `held_link`: a held place's link folds the placeholder a tournament gave it into whoever confirms
 *     (`confirmInvite`, the WhatsApp JOIN of a number's place too).
 *   - `telegram`: a Telegram account another record already held (`linkTelegram`).
 *   - `whatsapp`: a WhatsApp number another record already held (`linkWhatsapp`).
 *
 * `mergePlayers` takes the door, so a new caller cannot leave it out, and counts it itself.
 */
export const MERGE_DOORS = ["operator", "email_code", "same_name", "same_name_claim", "claim", "thats_me", "held_link", "telegram", "whatsapp"] as const;
export type MergeDoor = (typeof MERGE_DOORS)[number];

/**
 * How a merge's count is written. A request hands in `mergesLater` (`src/lib/mergeCount.ts`), which
 * writes it after the answer (`later`), never in the path a person waits on; with none, as in a test or
 * a script, `mergePlayers` writes it at once.
 */
export type MergeCounter = (door: MergeDoor, records: number) => Promise<void>;

/** Never throws: a merge must not fail because its counter did. */
export async function countMerge(db: Db, door: MergeDoor, records = 1): Promise<void> {
  if (records > 0) await bumpMetric(db, `merge_${door}`, records).catch(() => undefined);
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
