"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { restoreIdentity } from "@/actions/identity";

const KEY = "km_player";

/** Mirrors the cookie identity into localStorage and restores it if the cookie is gone. */
export function IdentitySync({ player }: { player: { id: string; name: string } | null }) {
  const router = useRouter();
  useEffect(() => {
    try {
      if (player) {
        localStorage.setItem(KEY, JSON.stringify(player));
        return;
      }
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { id?: string };
      if (!saved?.id) return;
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
