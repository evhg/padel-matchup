import "server-only";
import { createHmac } from "node:crypto";
import type { Db } from "@/db";
import { later } from "@/lib/later";
import { sessionSecret } from "@/lib/env";
import { saveDeviceHint, type HintScope } from "@/lib/domain/deviceHints";
import { canonicalSignals, cleanSignals, hintDecision, hintModeOf, isEuropeanZone, type HintMode } from "@/lib/domain/hintSignals";

/**
 * The server's side of a device hint (design B, the owner's decision of 28 October 2026): the switch, the
 * key, and the save every door calls. The rules are in src/lib/domain/hintSignals.ts, the rows in
 * src/lib/domain/deviceHints.ts.
 */

/**
 * `DEVICE_HINTS`, read on the server: `off` keeps no hint, `save` keeps them and asks nothing, `ask` keeps
 * them and lets part 2 ask "Welcome back, Tim?". Unset is `ask`, the owner's choice; a word it does not
 * know is `off`. Vercel applies a change at the next deploy (docs/OPERATING.md).
 */
export const deviceHintMode = (): HintMode => hintModeOf(process.env.DEVICE_HINTS);

/** The purpose the key's secret is derived under. A new purpose (`v2`) forgets every hint, which is safe. */
export const HINT_PURPOSE = "device-hint:v1";

/**
 * The key: HMAC-SHA256 over the canonical values, with a secret derived from `SESSION_SECRET` for this one
 * purpose, base64url. Without the secret nobody can tell which values made it; with it, the same phone
 * makes the same key in every browser that reports the same values. A rotation of `SESSION_SECRET` forgets
 * every hint, as it signs everybody out.
 */
export function hintKey(canonical: string, secret: string = sessionSecret()): string {
  const derived = createHmac("sha256", secret).update(HINT_PURPOSE).digest();
  return createHmac("sha256", derived).update(canonical).digest("base64url");
}

/**
 * Every door's one call, after the act succeeded and inside the same request: the browser's values came
 * with the act (no extra round trip), are checked here, and, with the switch on and a zone outside Europe,
 * the key is kept for the player after the answer (`later`), so nobody waits for it. A session by name
 * may save too: a hint never grants more than "That's me" already does. Never throws: a join or a sign-in
 * must not fail because its hint did.
 */
export async function saveHintLater(db: Db, playerId: string | null | undefined, raw: unknown, scope: HintScope = null, now = new Date()): Promise<void> {
  if (!playerId || raw === undefined || raw === null) return;
  const decision = hintDecision(raw, deviceHintMode());
  if (!decision.save) return;
  const key = hintKey(canonicalSignals(decision.signals));
  await later(() => saveDeviceHint(db, { playerId, key, label: decision.label, scope, now }));
}

/**
 * The key the question compares (part 2, "Welcome back, Tim?"): only with the switch at `ask`, every value
 * good and a zone outside Europe, as a save decides it (`hintDecision`); else null, and nothing is asked.
 * The server makes it; the browser never sees it.
 */
export function askKeyOf(raw: unknown): string | null {
  if (deviceHintMode() !== "ask" || raw === undefined || raw === null) return null;
  const decision = hintDecision(raw, "ask");
  return decision.save ? hintKey(canonicalSignals(decision.signals)) : null;
}

/**
 * The key that "Sign out on this browser" forgets (`signOutAction`): the key these values make, whatever
 * the switch says now, because a key kept before `DEVICE_HINTS` went `off` still names this phone. Null for
 * bad values and for a European zone, where no key was ever kept. The server makes it; the browser never sees it.
 */
export function forgetKeyOf(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const decision = hintDecision(raw, "save");
  return decision.save ? hintKey(canonicalSignals(decision.signals)) : null;
}

/** The values out of the Telegram return's cookie (`SIGNALS_COOKIE`), or null: at most 1 KB of JSON, and nothing else is read from it. */
export function signalsFromCookie(value: string | null | undefined): unknown {
  if (typeof value !== "string" || !value || value.length > 1024) return null;
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as unknown;
    const clean = cleanSignals(parsed);
    return clean && !isEuropeanZone(clean.tz) ? parsed : null;
  } catch {
    return null;
  }
}
