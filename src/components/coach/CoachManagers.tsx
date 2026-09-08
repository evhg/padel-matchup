"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
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
  if (!isOwner) return null;
  return (
    <section className="card flex flex-col gap-3" data-testid="coach-managers">
      <div>
        <h2 className="text-xl font-extrabold tracking-tight">{t("title")}</h2>
        <p className="text-sm text-muted">{t("lead")}</p>
      </div>
      {managers.length > 0 && (
        <ul className="flex flex-col gap-2 text-sm">
          {managers.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-white px-4 py-2">
              <span className="font-bold">{m.name}</span>
              <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => start(async () => { await removeManagerAction(m.id); router.refresh(); })}>
                {t("remove")}
              </button>
            </li>
          ))}
        </ul>
      )}
      {url ? (
        <div className="flex flex-col gap-2">
          <p className="break-all font-mono text-sm" data-testid="manager-link">{url}</p>
          <ShareButtons url={url} text={t("shareText", { url })} size="sm" />
        </div>
      ) : (
        <button type="button" className="btn-ghost w-full" disabled={pending} onClick={() => start(async () => { const r = await managerLinkAction(); if (r.ok) setUrl(r.data.url); })}>
          {pending ? "…" : t("makeLink")}
        </button>
      )}
      <HowThisWorks text={t("how")} />
    </section>
  );
}
