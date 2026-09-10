"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { adoptPersonalToken } from "@/actions/identity";

/**
 * On the personal-link page: give this device the identity cookie once. With
 * `next`, the action itself sends the device on (one navigation, cookie in
 * hand); without it, the page re-reads itself as the signed-in player. When
 * the device already holds the cookie the server has redirected before this
 * renders, so there is nothing to do here.
 */
export function AdoptToken({ token, needsCookie, next = null }: { token: string; needsCookie: boolean; next?: string | null }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !needsCookie) return;
    done.current = true;
    adoptPersonalToken(token, next).then((r) => {
      // A redirecting action resolves with nothing: the router is already on its way.
      if (r?.ok && r.data && !next) router.refresh();
    });
  }, [token, needsCookie, next, router]);
  return null;
}
