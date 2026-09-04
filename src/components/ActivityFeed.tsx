import { getLocale, getTranslations } from "next-intl/server";
import type { ActivityWithActor } from "@/lib/domain/queries";
import { relativeTime } from "@/lib/dates";

type YouVerb = "created" | "joined" | "joinedWaitlist" | "left" | "confirmed" | "promoted" | "score_entered" | "cancelled" | "updated";

/** Who did what, phrased from the viewer's side ("You added Zed" / "Zed was added by Erik"). */
export async function ActivityFeed({ items, viewerId }: { items: ActivityWithActor[]; viewerId: string | null }) {
  const t = await getTranslations();
  const locale = await getLocale();
  if (items.length === 0) return null;
  const line = (a: ActivityWithActor) => {
    const actor = a.actor?.displayName ?? t("activity.someone");
    const you = Boolean(viewerId && a.actorPlayerId === viewerId);
    const target = (a.meta?.name as string | undefined) ?? "";
    switch (a.verb) {
      case "invited":
        return you ? t("activity.addedByYou", { name: target }) : t("activity.addedBy", { name: target, actor });
      case "removed":
        return you ? t("activity.removedByYou", { name: target }) : t("activity.removedBy", { name: target, actor });
      case "declined":
        return t("activity.declined", { name: target || actor });
      case "joined": {
        const key: YouVerb = a.meta?.waitlist ? "joinedWaitlist" : "joined";
        return you ? t(`activity.you.${key}`) : t(`activity.${key}`, { name: actor });
      }
      default:
        return you ? t(`activity.you.${a.verb as YouVerb}`) : t(`activity.${a.verb}`, { name: actor });
    }
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
