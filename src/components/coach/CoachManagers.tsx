"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { coachErrorKey } from "@/lib/coach/errorKey";
import { useRouter } from "next/navigation";
import { managerLinkAction, removeManagerAction } from "@/actions/coach";
import { ShareButtons } from "@/components/ShareSheet";
import { HowThisWorks } from "./HowThisWorks";

type Props = { managers: { id: string; name: string }[]; isOwner: boolean };

/** One link to hand the person who runs the bookings; students never see a second name. */
export function CoachManagers({ managers, isOwner }: Props) {
  const t = useTranslations("coach.managers");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tCoach = useTranslations("coach");
  if (!isOwner) return null;
  // "Who runs your lessons with you" was a title a coach read twice and still did not know what it was
  // for. The section now opens with the question it answers, stays shut until it applies, and the
  // lead says who the helper is and what they can do.
  return (
    <section className="card flex flex-col gap-3" data-testid="coach-managers">
      <details open={managers.length > 0} className="group flex flex-col gap-3" data-testid="managers-fold">
        <summary className="cursor-pointer list-none text-base font-bold text-ink">
          <span className="mr-1 inline-block transition group-open:rotate-90">▸</span>
          {t("fold")}
        </summary>
      <div className="mt-3">
        <h2 className="text-xl font-extrabold tracking-tight">{t("title")}</h2>
        <p className="mt-1 text-sm text-ink">{t("lead")}</p>
      </div>
      {managers.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2 text-sm">
          {managers.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-card px-4 py-2">
              <span className="font-bold">{m.name}</span>
              <button
                type="button"
                className="btn-ghost btn-xs"
                disabled={pending}
                onClick={() => {
                  // A helper taken off loses the bookings they run, so it asks once, as the web does before any removal.
                  if (!confirm(t("removeConfirm", { name: m.name }))) return;
                  setError(null);
                  start(async () => {
                    const r = await removeManagerAction(m.id);
                    if (!r.ok) setError(tCoach(coachErrorKey(r.error)));
                    router.refresh();
                  });
                }}
              >
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {url ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className="break-all font-mono text-sm" data-testid="manager-link">{url}</p>
          <ShareButtons url={url} text={t("shareText", { url })} size="sm" />
        </div>
      ) : (
        <button type="button" className="btn-ghost mt-3 w-full" disabled={pending} onClick={() => start(async () => { setError(null); const r = await managerLinkAction(); if (r.ok) setUrl(r.data.url); else setError(tCoach(coachErrorKey(r.error))); })}>
          {pending ? "…" : t("makeLink")}
        </button>
      )}
      {error && (
        <p className="mt-2 text-sm font-semibold text-danger" role="alert">
          {error}
        </p>
      )}
      <HowThisWorks text={t("how")} />
      </details>
    </section>
  );
}
