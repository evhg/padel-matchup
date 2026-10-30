"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { signOutAction } from "@/actions/identity";
import { browserPushSubscription, forgetBrowser } from "@/lib/browserKeys";
import { readDeviceSignals } from "@/lib/deviceSignals";

/**
 * "Not you? Sign out on this browser" (the owner, 28 October 2026), where a signed-in player sees their own
 * name: the header's menu and My matches. The words come from the server as props, because the header is
 * on every page and the browser gets only the messages its page hands it. One confirm, then the storage
 * the page keeps about the person goes (`forgetBrowser`: the restore seal first, so nothing can bring the
 * session back), then the cookies and this browser's push subscription on the server (`signOutAction`),
 * then the subscription in the browser, and the page renders again signed out. A notification carries the
 * personal link, so a subscription left behind would sign the next person in as the player. Never on the
 * personal-link page, whose address is itself the sign-in (`MySettings`' `signOut`).
 *
 * The call carries this browser's device values, as every door's does (`readDeviceSignals`: nothing in a
 * European zone), and the server forgets the key that these values make from the record that signs out
 * (DECIDING, "A phone is never shared"). A key kept under other values stays (`signOutAction`). The values
 * are read before the storage goes, in the same tap.
 */
export function SignOut({ notYou, label, confirmText, testId, compact = false }: { notYou: string; label: string; confirmText: string; testId: string; compact?: boolean }) {
  const [pending, start] = useTransition();
  return (
    <p className={compact ? "px-2 py-1 text-xs text-muted" : "mt-2 text-sm text-muted"}>
      {notYou}{" "}
      <button
        type="button"
        className="font-semibold underline hover:text-ink disabled:opacity-60"
        data-testid={testId}
        disabled={pending}
        onClick={() => {
          if (!confirm(confirmText)) return;
          // The read starts here, before the storage goes; its tests take a moment and the request waits for them.
          const reading = readDeviceSignals();
          forgetBrowser();
          start(async () => {
            const hint = await reading;
            const sub = await browserPushSubscription();
            await signOutAction(sub?.endpoint ?? null, { hint });
            // After the server's delete. Should that delete have failed, the push service now answers "gone" and the next send removes the row.
            await sub?.unsubscribe().catch(() => undefined);
          });
        }}
      >
        {label}
      </button>
    </p>
  );
}

/**
 * The header menu's foot: "Signed in as Tim" and the sign-out under it. Rendered only while the menu is
 * open, so the name is not on every page twice: a closed `<details>` still holds its text, and a browser
 * suite's `getByText("Tim")` counts hidden text too (`.claude/skills/ship/SKILL.md`, "A list that repeats
 * what a screen says").
 */
export function MenuSignOut({ signedInAs, notYou, label, confirmText }: { signedInAs: string; notYou: string; label: string; confirmText: string }) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const menu = anchor.current?.closest("details");
    if (!menu) return;
    const sync = () => setOpen(menu.open);
    sync();
    menu.addEventListener("toggle", sync);
    return () => menu.removeEventListener("toggle", sync);
  }, []);
  return (
    <div ref={anchor} className="contents">
      {open && (
        <>
          <div className="my-1 border-t border-line" />
          <p className="px-2 pt-1 text-xs font-semibold text-ink" data-testid="nav-signed-in">
            {signedInAs}
          </p>
          <SignOut notYou={notYou} label={label} confirmText={confirmText} testId="nav-signout" compact />
        </>
      )}
    </div>
  );
}
