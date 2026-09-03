"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { restoreIdentity } from "@/actions/identity";

const KEY = "km_player";
const HAS_ID_COOKIE = "km_has_id";

/**
 * Mirrors the cookie identity into localStorage and restores it if the cookie
 * is gone. Restores at most once per page load, and never when the browser
 * still holds the identity cookie (a render can be stale, e.g. a prefetched
 * layout from before the visitor entered a name).
 */
export function IdentitySync({ player }: { player: { id: string; name: string } | null }) {
  const router = useRouter();
  const attempted = useRef(false);
  useEffect(() => {
    try {
      if (player) {
        localStorage.setItem(KEY, JSON.stringify(player));
        return;
      }
      if (attempted.current) return;
      if (document.cookie.split("; ").some((c) => c.startsWith(`${HAS_ID_COOKIE}=`))) return;
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { id?: string };
      if (!saved?.id) return;
      attempted.current = true;
      restoreIdentity(saved.id).then((r) => {
        if (r.ok && r.data) router.refresh();
        else localStorage.removeItem(KEY);
      });
    } catch {
      /* storage unavailable */
    }
  }, [player, router]);
  return null;
}
