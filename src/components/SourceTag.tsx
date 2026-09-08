"use client";

import { useEffect } from "react";
import { SOURCE_COOKIE, SOURCE_MAX_AGE } from "@/lib/source";

/** Remembers ?s=… for a day so the join that follows is counted per source. Renders nothing. */
export function SourceTag({ source }: { source: string | null }) {
  useEffect(() => {
    if (!source) return;
    try {
      document.cookie = `${SOURCE_COOKIE}=${encodeURIComponent(source)}; max-age=${SOURCE_MAX_AGE}; path=/; samesite=lax`;
    } catch {
      /* private mode */
    }
  }, [source]);
  return null;
}
