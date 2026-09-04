"use client";

import { useLayoutEffect } from "react";

/**
 * Confirmation screens open at the top. After an in-app redirect (create,
 * play again) the router keeps the previous scroll offset, and client
 * components mounting below can nudge it again via scroll anchoring, so we
 * pin the top before paint and once more after the first settle.
 */
export function ScrollTop() {
  useLayoutEffect(() => {
    // "instant" overrides the global `scroll-behavior: smooth`, which otherwise
    // animates the jump for ~400ms and can be caught mid-way.
    const top = () => window.scrollTo({ top: 0, left: 0, behavior: "instant" as ScrollBehavior });
    top();
    const raf = requestAnimationFrame(top);
    const timer = setTimeout(top, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, []);
  return null;
}
