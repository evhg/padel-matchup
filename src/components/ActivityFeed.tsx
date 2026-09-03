import { getLocale, getTranslations } from "next-intl/server";
import type { ActivityWithActor } from "@/lib/domain/queries";
import { relativeTime } from "@/lib/dates";

export async function ActivityFeed({ items }: { items: ActivityWithActor[] }) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (items.length === 0) return null;
  const line = (a: ActivityWithActor) => {
    const name = a.actor?.displayName ?? (a.meta?.name as string | undefined) ?? t("activity.someone");
    if (a.verb === "joined" && a.meta?.waitlist) return t("activity.joinedWaitlist", { name });
    return t(`activity.${a.verb}`, { name });
  };
  return (
    <details className="card group">
      <summary className="flex cursor-pointer list-none items-center justify-between font-extrabold">
        <span>
          {t("event.activity")} <span className="text-muted">· {items.length}</span>
        </span>
        <span className="text-muted transition group-open:rotate-180">⌄</span>
      </summary>
      <ul className="mt-3 flex flex-col gap-2 text-sm">
        {items.map((a) => (
          <li key={a.id} className="flex justify-between gap-3">
            <span>{line(a)}</span>
            <span className="shrink-0 text-faint">{relativeTime(a.createdAt, locale)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
