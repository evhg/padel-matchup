/**
 * What a page's script keeps in this browser's storage about the person signed in, in one place, so
 * "Not you? Sign out" forgets all of it (`forgetBrowser`; the owner, 28 October 2026). Safe in a browser.
 *
 * - `RESTORE_KEY`: the restore seal `IdentitySync` keeps, the way back after a lost cookie. Once the
 *   browser signed out, the server refuses any seal from before (`predatesSignOut`); removing it here
 *   means the page never even asks.
 * - `PASSKEY_NOT_NOW`: the "Not now" of the "Remember me on this phone" card, one for the match page and
 *   one for My matches (`RememberPhone`). The next person on this browser gets the card again.
 * - `PASSKEY_SHOWN_DAY`: the day the card last counted itself shown (`passkey_shown`), once a day.
 */
export const RESTORE_KEY = "km_player";
export const PASSKEY_NOT_NOW = { match: "km_passkey_not_now", me: "km_passkey_not_now_me" } as const;
export const PASSKEY_SHOWN_DAY = "km_passkey_shown_day";

export function forgetBrowser(): void {
  try {
    for (const key of [RESTORE_KEY, ...Object.values(PASSKEY_NOT_NOW), PASSKEY_SHOWN_DAY]) localStorage.removeItem(key);
  } catch {
    /* storage unavailable: nothing kept to forget */
  }
}

/**
 * This browser's push subscription, or null where there is none or the browser cannot say. Only looks:
 * it never registers the service worker, so a browser that never turned notifications on starts nothing.
 * "Not you? Sign out" hands its endpoint to the server, which deletes the row, and then ends it here.
 */
export async function browserPushSubscription(): Promise<PushSubscription | null> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration("/");
    return (await reg?.pushManager?.getSubscription()) ?? null;
  } catch {
    return null;
  }
}
