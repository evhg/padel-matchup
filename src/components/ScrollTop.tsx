"use client";

import { useLayoutEffect } from "react";

/**
 * Confirmation screens open at the top. After an in-app redirect (create,
 * play again) the router keeps the previous scroll offset, which left the
 * share screen half-way down the page. Layout effect: before first paint.
 */
export function ScrollTop() {
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, []);
  return null;
}
