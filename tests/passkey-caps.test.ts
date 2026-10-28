import { describe, expect, it } from "vitest";
import { canAutofillPasskey, canKeepPasskey, handheld, type PasskeyApi } from "@/lib/passkeys/caps";

/**
 * What a browser can do with a passkey, asked the newest way first (src/lib/passkeys/caps.ts): Chrome on
 * iOS 26.2 and later may answer false to `isUserVerifyingPlatformAuthenticatorAvailable()` while it can
 * keep and use a passkey, so `getClientCapabilities()` answers first where it exists, for the autofill on
 * the name field and for the "Remember me on this phone" card alike. Each browser here is a fake object
 * shaped like `PublicKeyCredential`; nothing global is touched.
 */

const yes = async () => true;
const no = async () => false;
const broken = async (): Promise<boolean> => {
  throw new Error("SecurityError");
};
const caps = (c: Record<string, boolean | undefined>) => async () => c;

describe("the autofill on the name field", () => {
  it("takes the capability's answer first, either way", async () => {
    // Chrome on iOS: the new call says yes, the old one no.
    expect(await canAutofillPasskey({ getClientCapabilities: caps({ conditionalGet: true }), isConditionalMediationAvailable: no })).toBe(true);
    expect(await canAutofillPasskey({ getClientCapabilities: caps({ conditionalGet: false }), isConditionalMediationAvailable: yes })).toBe(false);
  });

  it("asks the older call where the capability is not named, or the new call is missing or fails", async () => {
    expect(await canAutofillPasskey({ getClientCapabilities: caps({ hybridTransport: true }), isConditionalMediationAvailable: yes })).toBe(true);
    expect(await canAutofillPasskey({ isConditionalMediationAvailable: yes })).toBe(true);
    expect(await canAutofillPasskey({ getClientCapabilities: async () => { throw new Error("NotSupportedError"); }, isConditionalMediationAvailable: yes })).toBe(true);
    expect(await canAutofillPasskey({ isConditionalMediationAvailable: no })).toBe(false);
  });

  it("says no for a browser with no WebAuthn, no answer, or an answer that throws", async () => {
    expect(await canAutofillPasskey(null)).toBe(false);
    expect(await canAutofillPasskey({})).toBe(false);
    expect(await canAutofillPasskey({ isConditionalMediationAvailable: broken })).toBe(false);
  });
});

const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

describe("the card \"Remember me on this phone\"", () => {
  it("takes the capabilities' answer first: a verifying platform authenticator is a yes, its false a no", async () => {
    expect(await canKeepPasskey({ getClientCapabilities: caps({ passkeyPlatformAuthenticator: true }), isUserVerifyingPlatformAuthenticatorAvailable: no }, false)).toBe(true);
    expect(await canKeepPasskey({ getClientCapabilities: caps({ userVerifyingPlatformAuthenticator: true }), isUserVerifyingPlatformAuthenticatorAvailable: no }, false)).toBe(true);
    expect(await canKeepPasskey({ getClientCapabilities: caps({ passkeyPlatformAuthenticator: false, userVerifyingPlatformAuthenticator: false }), isUserVerifyingPlatformAuthenticatorAvailable: yes }, true)).toBe(false);
  });

  it("gives Chrome on iOS the card, and a desktop that only reaches another phone over a QR code none", async () => {
    // Chrome on iOS 26.2: the older call and its capability say no, while it keeps passkeys in the phone's own password manager.
    const chromeIos = { getClientCapabilities: caps({ passkeyPlatformAuthenticator: true, hybridTransport: true, userVerifyingPlatformAuthenticator: false }), isUserVerifyingPlatformAuthenticatorAvailable: no };
    expect(await canKeepPasskey(chromeIos, handheld(IPHONE_CHROME, 5))).toBe(true);
    // The same answers from a desktop browser with Bluetooth and no Face ID or fingerprint: a save would go to another phone.
    expect(await canKeepPasskey(chromeIos, handheld(DESKTOP_CHROME, 0))).toBe(false);
    // Hybrid named and the verifying authenticator not: the older call decides on a desktop.
    const desktop = (older: () => Promise<boolean>) => ({ getClientCapabilities: caps({ passkeyPlatformAuthenticator: true, hybridTransport: true }), isUserVerifyingPlatformAuthenticatorAvailable: older });
    expect(await canKeepPasskey(desktop(no), false)).toBe(false);
    expect(await canKeepPasskey(desktop(yes), false)).toBe(true);
    // No hybrid: the platform authenticator is the browser's own.
    expect(await canKeepPasskey({ getClientCapabilities: caps({ passkeyPlatformAuthenticator: true, hybridTransport: false }), isUserVerifyingPlatformAuthenticatorAvailable: no }, false)).toBe(true);
  });

  it("knows a phone or a tablet by its user agent, an iPad on the desktop site by its touch screen", () => {
    expect(handheld(IPHONE_CHROME, 5)).toBe(true);
    expect(handheld("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", 5)).toBe(true);
    expect(handheld(IPAD_DESKTOP, 5)).toBe(true);
    expect(handheld(IPAD_DESKTOP, 0)).toBe(false);
    expect(handheld(DESKTOP_CHROME, 10)).toBe(false);
    expect(handheld("", 0)).toBe(false);
  });

  it("asks the older call where the capabilities do not say, or the new call is missing", async () => {
    expect(await canKeepPasskey({ getClientCapabilities: caps({ passkeyPlatformAuthenticator: false }), isUserVerifyingPlatformAuthenticatorAvailable: yes }, false)).toBe(true);
    expect(await canKeepPasskey({ getClientCapabilities: async () => null, isUserVerifyingPlatformAuthenticatorAvailable: yes }, false)).toBe(true);
    expect(await canKeepPasskey({ isUserVerifyingPlatformAuthenticatorAvailable: yes }, false)).toBe(true);
    expect(await canKeepPasskey({ isUserVerifyingPlatformAuthenticatorAvailable: no }, true)).toBe(false);
  });

  it("says no for a browser with no WebAuthn, or an answer that throws", async () => {
    expect(await canKeepPasskey(null, true)).toBe(false);
    expect(await canKeepPasskey({ isUserVerifyingPlatformAuthenticatorAvailable: broken } as PasskeyApi, true)).toBe(false);
  });
});
