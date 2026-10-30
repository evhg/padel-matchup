"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { adoptPersonalToken } from "@/actions/identity";
import { readDeviceSignals } from "@/lib/deviceSignals";

/**
 * On the personal-link page: give this device the identity cookie once, then
 * the page re-reads itself as the signed-in player. A link with a destination
 * never gets here: the server hands the device on by itself.
 *
 * Decided on the first render only. A later render of the same page (an action that changed the
 * cookies, a refresh) can turn `needsCookie` true, and adopting then would sign the browser in again
 * behind the person's back: "Sign out on this browser" did exactly that here until 28 October 2026.
 * Opening the link again is a new page, and signs in as before.
 */
export function AdoptToken({ token, needsCookie }: { token: string; needsCookie: boolean }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (!needsCookie) return;
    readDeviceSignals()
      .then((hint) => adoptPersonalToken(token, hint))
      .then((r) => {
        if (r.ok && r.data) router.refresh();
      });
  }, [token, needsCookie, router]);
  return null;
}
