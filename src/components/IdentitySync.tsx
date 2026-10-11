"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { restoreIdentity } from "@/actions/identity";

const KEY = "km_player";
const HAS_ID_COOKIE = "km_has_id";

/**
 * Keeps the server's restore seal for the signed-in browser in localStorage, and sends it back if the
 * cookie is gone. The seal is the only thing kept: never a player id, which other people's screens
 * can show and which proves nothing (`restoreSeal` in src/lib/session.ts). An entry from before
 * 11 October 2026 holds a raw id; it restores nothing and is removed. Restores at most once per page
 * load, and never when the browser still holds the identity cookie (a render can be stale, e.g. a
 * prefetched layout from before the visitor entered a name).
 */
export function IdentitySync({ seal }: { seal: string | null }) {
  const router = useRouter();
  const attempted = useRef(false);
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
