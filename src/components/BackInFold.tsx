"use client";

import { useEffect, useRef } from "react";
import { registerBackInHandler } from "./backInBus";

/**
 * The closed "used this before?" line, which the join row above can now open.
 *
 * It is a `<details>` so that it still opens with no JavaScript at all, the way it always did. The
 * only thing the client half adds is a way for somebody typing a name that is already in this match
 * to be taken straight here, open, rather than told to go and look for it.
 */
export function BackInFold({ summary, children }: { summary: string; children: React.ReactNode }) {
  const box = useRef<HTMLDetailsElement>(null);

  useEffect(
    () =>
      registerBackInHandler(() => {
        const el = box.current;
        if (!el) return;
        el.open = true;
        requestAnimationFrame(() => el.scrollIntoView({ block: "center", behavior: "smooth" }));
      }),
    [],
  );

  return (
    <details ref={box} className="mt-3 border-t border-line pt-3">
      <summary className="cursor-pointer list-none link text-sm font-semibold">{summary}</summary>
      {children}
    </details>
  );
}
