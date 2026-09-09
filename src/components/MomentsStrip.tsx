import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import type { Db } from "@/db";
import { listMilestones } from "@/lib/domain/milestones";
import { momentLine } from "@/lib/moments";

/** On My matches: the moments a player earned, each one tap from its picture and the share sheet. Empty means nothing shown. */
export async function MomentsStrip({ db, playerId }: { db: Db; playerId: string }) {
  const rows = await listMilestones(db, playerId, 8);
  if (rows.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations("moments"), getLocale()]);
  const lines = await Promise.all(rows.map((m) => momentLine(m, locale)));
  return (
    <section className="card" data-testid="moments">
      <h2 className="text-lg font-extrabold">{t("title")}</h2>
      <p className="mt-1 text-xs text-muted">{t("lead")}</p>
      <ul className="mt-3 flex gap-3 overflow-x-auto pb-1">
        {rows.map((m, i) => (
          <li key={m.id} className="w-56 shrink-0 overflow-hidden rounded-2xl border border-line bg-white">
            <Link href={`/m/${m.id}`} prefetch={false} className="block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/m/${m.id}/opengraph-image`} alt={lines[i]} width={1200} height={630} className="block h-auto w-full" />
              <div className="px-3 py-2 text-sm font-bold">{lines[i]}</div>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
