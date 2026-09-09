"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { COACH_COOKIE } from "@/lib/coachCookie";

/**
 * The one link in the header. In a browser a coach has used it goes to the
 * assistant (My matches is one tap away from there); everywhere else it is
 * My matches. Reads a cookie, never the database, and never widens the header.
 */
export function HeaderNav({ assistantLabel, myMatchesLabel }: { assistantLabel: string; myMatchesLabel: string }) {
  const [coach, setCoach] = useState(false);
  useEffect(() => {
    setCoach(document.cookie.split("; ").some((c) => c === `${COACH_COOKIE}=1`));
  }, []);
  if (coach) {
    return (
      <Link href="/coach" prefetch={false} className="btn-ghost btn-xs" data-testid="assistant-link">
        🎾 {assistantLabel}
      </Link>
    );
  }
  return (
    <Link href="/me" prefetch={false} className="btn-ghost btn-xs">
      {myMatchesLabel}
    </Link>
  );
}
