"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { adoptPersonalToken } from "@/actions/identity";

/** On the personal-link page: give this device the identity cookie once. */
export function AdoptToken({ token, needsCookie }: { token: string; needsCookie: boolean }) {
  const router = useRouter();
  const done = useRef(false);
  useEffect(() => {
    if (!needsCookie || done.current) return;
    done.current = true;
    adoptPersonalToken(token).then((r) => {
      if (r.ok && r.data) router.refresh();
    });
  }, [token, needsCookie, router]);
  return null;
}
