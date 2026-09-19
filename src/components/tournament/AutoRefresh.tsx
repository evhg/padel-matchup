"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** The page asks the server again every so often: the club's screen and a page open on a phone during play stay current without a tap. */
export function AutoRefresh({ seconds }: { seconds: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
