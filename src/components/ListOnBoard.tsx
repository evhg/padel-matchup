"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateEventAction } from "@/actions/events";

/**
 * The organiser's one tap that puts a match with a venue on that venue's board. The switch in More
 * options stays for taking it off again; the way on was three taps down, and a match at a club that
 * nobody at the club could see.
 */
export function ListOnBoard({ code, venue }: { code: string; venue: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [failed, setFailed] = useState(false);
  const list = () =>
    start(async () => {
      const r = await updateEventAction(code, { publicListing: true });
      if (r.ok) router.refresh();
      else setFailed(true);
    });
  return (
    <button type="button" className="chip-muted hover:bg-line disabled:opacity-60" onClick={list} disabled={pending} aria-busy={pending} data-testid="list-on-board">
      📍 {failed ? t("common.somethingWrong") : t("venue.listNow", { venue })}
    </button>
  );
}
