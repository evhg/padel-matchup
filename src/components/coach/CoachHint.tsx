"use client";

import { useEffect } from "react";
import { forgetCoachAction, rememberCoachAction } from "@/actions/coach";
import { COACH_COOKIE } from "@/lib/coachCookie";

/**
 * On the coach's own page: mark this browser as a coach's once, so the header
 * shows the way back from any screen. On the setup screen for someone who is
 * not a coach: take a stale mark away, so the header goes back to My matches.
 */
export function CoachHint({ present }: { present: boolean }) {
  useEffect(() => {
    const has = document.cookie.split("; ").some((c) => c === `${COACH_COOKIE}=1`);
    if (present && !has) rememberCoachAction().catch(() => undefined);
    if (!present && has) forgetCoachAction().catch(() => undefined);
  }, [present]);
  return null;
}
