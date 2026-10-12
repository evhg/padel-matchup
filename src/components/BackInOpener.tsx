"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { canAskBackIn, requestBackInSoon, subscribeBackIn } from "./backInBus";
import { requestJoin } from "./joinBus";

/**
 * "Played before? Sign in": one closed line under the line-up, for a browser that knows nobody, on a
 * match page whose join form holds the ways back in (`BackInHelp`, DECIDING rule 39). The tap opens that
 * form and brings its help on screen. Without it, a player already seated from another browser, whose
 * record has an email or a passkey and so no "That's me", saw no way back in until they tapped "Join this
 * match" for a match they were already in (review, 12 October 2026). No server call (rule 12).
 *
 * `doorsOn`: the email code or Telegram runs here (rule 4). With neither, the help holds Face ID or a
 * fingerprint alone, so the line shows only where the browser can do that. While the help is on the page
 * (the join form is open), the line steps aside: one way back in on screen at a time (rule 3).
 */
export function BackInOpener({ label, doorsOn }: { label: string; doorsOn: boolean }) {
  const [can, setCan] = useState(doorsOn);
  const helpOpen = useSyncExternalStore(subscribeBackIn, canAskBackIn, () => false);
  useEffect(() => {
    if (!doorsOn) setCan(typeof window.PublicKeyCredential === "function");
  }, [doorsOn]);
  if (!can || helpOpen) return null;
  return (
    <div className="mt-3 border-t border-line pt-3" data-testid="event-back-in-line">
      <button
        type="button"
        className="link text-left text-sm font-semibold"
        onClick={() => {
          if (requestJoin()) requestBackInSoon();
        }}
      >
        {label}
      </button>
    </div>
  );
}
