"use client";

import { useEffect } from "react";
import { rememberCoachAction } from "@/actions/coach";
import { COACH_COOKIE } from "@/lib/coachCookie";

/** On the coach's own page: mark this browser as a coach's once, so the header shows the way back from any screen. */
export function CoachHint() {
  useEffect(() => {
    if (document.cookie.split("; ").some((c) => c === `${COACH_COOKIE}=1`)) return;
    rememberCoachAction().catch(() => undefined);
  }, []);
  return null;
}
