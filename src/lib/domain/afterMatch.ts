/**
 * The match page once the match is over (the owner, 26 November 2026). Pure, and the one answer the page
 * asks; `tests/match-after.test.ts` holds it.
 *
 * "Since this is a public page that people can share ... only players and organizer can change it", and
 * "All the organizer tools, 4/4 players, confirm levels sections, make sure these are hidden except to any of
 * the players or organizer". So after the end the organiser and the seated players (`inside`) see the
 * line-up, "Play again", "Edit score", Organizer tools and "Confirm levels"; a visitor sees the result, the
 * card, its share and the reel's public parts, and nothing that asks them to sign in. The server keeps the
 * same rule on its own: `saveMatchScore` refuses `not_participant`, `duplicateEventAction` `forbidden`.
 */

/**
 * The share card under the match numbers after a match (`MatchShare` with "Share the result"). The owner,
 * 26 November 2026: "the big share the result button is redundant? We already have it under the game card.
 * Hide the entire section for now." The code stays; `true` brings it back.
 */
export const SHARE_CARD_AFTER_MATCH = false;

/**
 * The one exception to "players and organiser only" for the line-up: a viewer who is signed in, has no seat,
 * and whom the line-up fix still lets in (the owner's decision of 24 November 2026, `fixRights`: "I played
 * instead of Bo", take an open place) keeps the line-up for those seven days, because the line-up is where
 * that door is. `false` hides the line-up from that viewer too, and the door then closes on the page.
 */
export const STRANGER_FIX_DOOR = true;

/**
 * The second exception, for a browser that knows nobody: where "That's me" can sign it in as a record of this
 * match (DECIDING rule 34; "That's me" for past organisers, the owner, 11 October 2026), the line-up stays,
 * because the line-up's rows are that door. Identity is the owner's decision, so this keeps today's door until
 * the owner says otherwise. `false` hides the line-up from every signed-out visitor after the match, as the
 * owner's words of 26 November 2026 read, and a player in a new browser then signs in from My matches (the
 * email code, Telegram, a passkey) instead. `e2e/core.mjs` signs Sofia in by "That's me" on PAST: with
 * `false`, that walk needs another way in first.
 */
export const THATS_ME_DOOR = true;

export type AfterMatchViewer = {
  /** The match is over: its own length ran out, or the sweep said so. */
  over: boolean;
  /** The organiser, by the session or by the manage link. */
  organiser: boolean;
  /** A seat inside the capacity. */
  member: boolean;
  signedIn: boolean;
  /** The line-up fix lets this viewer take or replace a place (`fixRights`' `take` or `replace`). */
  fixDoor: boolean;
  /** A browser that knows nobody, and "That's me" offers it a record on this line-up (`thatsMeOffer`'s `ids`). */
  thatsMeDoor: boolean;
};

export function afterMatchView(v: AfterMatchViewer): { inside: boolean; lineup: boolean; scoreReason: boolean } {
  const inside = v.organiser || v.member;
  if (!v.over) return { inside, lineup: true, scoreReason: true };
  return {
    inside,
    lineup: inside || (STRANGER_FIX_DOOR && v.signedIn && v.fixDoor) || (THATS_ME_DOOR && !v.signedIn && v.thatsMeDoor),
    // "Only players in this match can enter the score" is for nobody outside it once it is over.
    scoreReason: inside,
  };
}
