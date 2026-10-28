"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { restoreIdentity } from "@/actions/identity";
import { RESTORE_KEY } from "@/lib/browserKeys";

const KEY = RESTORE_KEY;
const HAS_ID_COOKIE = "km_has_id";

/**
 * Keeps the server's restore seal for the signed-in browser in localStorage, and sends it back if the
 * cookie is gone. The seal is the only thing kept: never a player id, which other people's screens
 * can show and which proves nothing (`restoreSeal` in src/lib/session.ts). An entry from before
 * 11 October 2026 holds a raw id; it restores nothing and is removed. Restores at most once per page
 * load, and never when the browser still holds the identity cookie (a render can be stale, e.g. a
 * prefetched layout from before the visitor entered a name).
 *
 * `check`: what the root layout saw in the cookies, which only a route may act on, because a page cannot
 * set a cookie (`POST /api/me/session`): `renew`, a full sign-in due its new year (once in 30 days at
 * most, the owner, 28 October 2026); `dead`, a signed cookie whose record is gone, ended and counted once
 * (`session_dead`). Asked once per page load, after the page is on the screen.
 */
export function IdentitySync({ seal, check = null }: { seal: string | null; check?: "renew" | "dead" | null }) {
  const router = useRouter();
  const attempted = useRef(false);
  const checked = useRef(false);
  useEffect(() => {
    if (!check || checked.current) return;
    checked.current = true;
    fetch(`/api/me/session?do=${check}`, { method: "POST", credentials: "same-origin" }).catch(() => undefined);
  }, [check]);
  useEffect(() => {
    try {
      if (seal) {
        localStorage.setItem(KEY, JSON.stringify({ seal }));
        return;
      }
      if (attempted.current) return;
      if (document.cookie.split("; ").some((c) => c.startsWith(`${HAS_ID_COOKIE}=`))) return;
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { seal?: unknown };
      if (typeof saved?.seal !== "string") {
        localStorage.removeItem(KEY);
        return;
      }
      attempted.current = true;
      restoreIdentity(saved.seal).then((r) => {
        if (r.ok && r.data) router.refresh();
        else localStorage.removeItem(KEY);
      });
    } catch {
      /* storage unavailable */
    }
  }, [seal, router]);
  return null;
}
