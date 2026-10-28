/**
 * What the browser can do with a passkey, asked the newest way first. Safe in a browser and in a test:
 * pure over the `PublicKeyCredential` it is handed, no library, no server.
 *
 * Why the order. `PublicKeyCredential.getClientCapabilities()` (WebAuthn Level 3) answers every question
 * at once, and Chrome on iOS 26.2 and later may answer false to the older
 * `isUserVerifyingPlatformAuthenticatorAvailable()` while it can keep and use a passkey. So where the
 * new call exists it is asked first; a capability it does not name (undefined, "unknown") falls back to
 * the older call, as the library's own `getBrowserCapabilities` does. An error anywhere is a no.
 */

/**
 * The request options a page renders for a browser that knows nobody (`pageSignInOptions` in
 * src/lib/passkeys/page.ts): no list of passkeys, Face ID or a fingerprint required. `expiresAt` (epoch
 * ms) is when the challenge stops signing in; it stays in the browser (src/lib/passkeys/autofill.ts) and
 * never goes to the phone.
 */
export type PageSignInOptions = { challenge: string; rpId: string; userVerification: "required"; expiresAt: number };

/** The little of `PublicKeyCredential` these questions read, so a test can hand in its own. */
export type PasskeyApi = {
  getClientCapabilities?: () => Promise<Record<string, boolean | undefined> | null | undefined>;
  isConditionalMediationAvailable?: () => Promise<boolean>;
  isUserVerifyingPlatformAuthenticatorAvailable?: () => Promise<boolean>;
};

/** The browser's own `PublicKeyCredential`, or null where there is none (a server, an old browser, a webview without WebAuthn). */
export function browserPasskeyApi(): PasskeyApi | null {
  const g = globalThis as { PublicKeyCredential?: PasskeyApi };
  return typeof g.PublicKeyCredential === "function" || (typeof g.PublicKeyCredential === "object" && g.PublicKeyCredential !== null) ? g.PublicKeyCredential : null;
}

/** The capabilities the new call names: true or false for each it knows, nothing for the rest. */
async function capabilities(api: PasskeyApi): Promise<Record<string, boolean | undefined>> {
  if (typeof api.getClientCapabilities !== "function") return {};
  try {
    const caps = await api.getClientCapabilities();
    return caps && typeof caps === "object" ? caps : {};
  } catch {
    return {};
  }
}

async function older(fn: (() => Promise<boolean>) | undefined, api: PasskeyApi): Promise<boolean> {
  if (typeof fn !== "function") return false;
  try {
    return (await fn.call(api)) === true;
  } catch {
    return false;
  }
}

/**
 * Can this browser offer a passkey in the autofill above the keyboard (a conditional request)? The
 * capability `conditionalGet` first, then `isConditionalMediationAvailable()`.
 */
export async function canAutofillPasskey(api: PasskeyApi | null = browserPasskeyApi()): Promise<boolean> {
  if (!api) return false;
  const caps = await capabilities(api);
  if (typeof caps.conditionalGet === "boolean") return caps.conditionalGet;
  return older(api.isConditionalMediationAvailable, api);
}

/**
 * A phone or a tablet, by the browser's own words: an iPad that asks for the desktop site says
 * "Macintosh" and has a touch screen, which no Mac has.
 */
export function handheld(ua: string = globalThis.navigator?.userAgent ?? "", touchPoints: number = globalThis.navigator?.maxTouchPoints ?? 0): boolean {
  return /iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

/**
 * Can this phone keep a passkey itself, behind Face ID, a fingerprint or its lock ("Remember me on this
 * phone")? The capability `userVerifyingPlatformAuthenticator` first: true is a yes, false a no, as the
 * older call answers. Then `passkeyPlatformAuthenticator`, which WebAuthn Level 3 also gives a browser
 * that reaches another phone over a QR code (hybrid): alone it is a yes only where the browser offers no
 * hybrid, or on a phone or a tablet (`handheld`), so that Chrome on iOS 26.2, which may say false to the
 * older call, still gets the card, and a desktop with Bluetooth and no Face ID or fingerprint of its own
 * does not (review, 28 October 2026). Nothing named: `isUserVerifyingPlatformAuthenticatorAvailable()`.
 */
export async function canKeepPasskey(api: PasskeyApi | null = browserPasskeyApi(), onHandheld: boolean = handheld()): Promise<boolean> {
  if (!api) return false;
  const caps = await capabilities(api);
  if (caps.userVerifyingPlatformAuthenticator === true) return true;
  if (caps.passkeyPlatformAuthenticator === true && (caps.hybridTransport !== true || onHandheld)) return true;
  if (caps.userVerifyingPlatformAuthenticator === false) return false;
  return older(api.isUserVerifyingPlatformAuthenticatorAvailable, api);
}
