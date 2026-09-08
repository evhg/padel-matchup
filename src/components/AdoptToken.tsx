"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { adoptPersonalToken } from "@/actions/identity";

/** On the personal-link page: give this device the identity cookie once. */
export function AdoptToken({ token, needsCookie, next = null }: { token: string; needsCookie: boolean; next?: string | null }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    if (!needsCookie) {
      if (next) router.replace(next);
      return;
    }
    adoptPersonalToken(token).then((r) => {
      if (r.ok && r.data) {
        if (next) router.replace(next);
        else router.refresh();
      }
    });
  }, [token, needsCookie, next, router]);
  return null;
}
