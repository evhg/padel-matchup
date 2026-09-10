"use client";

import { useEffect } from "react";
import { SOURCE_COOKIE, SOURCE_MAX_AGE } from "@/lib/source";

/** Remembers ?s=… for a day so the join that follows is counted per source. Renders nothing. */
export function SourceTag({ source, cookie = SOURCE_COOKIE }: { source: string | null; cookie?: string }) {
  useEffect(() => {
    if (!source) return;
    try {
      document.cookie = `${cookie}=${encodeURIComponent(source)}; max-age=${SOURCE_MAX_AGE}; path=/; samesite=lax`;
    } catch {
      /* private mode */
    }
  }, [source, cookie]);
  return null;
}
