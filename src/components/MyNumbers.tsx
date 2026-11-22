import Link from "next/link";
import { getTranslations } from "next-intl/server";
import type { Db } from "@/db";
import { bestsOf } from "@/lib/domain/matchStatKinds";
import { playerNumbers } from "@/lib/domain/matchStats";
import { StatTiles } from "./StatTiles";

/** On My matches: the player's best numbers, and the way to "My stats". Nothing while there are none (rule 3). */
export async function MyNumbers({ db, playerId }: { db: Db; playerId: string }) {
  const rows = await playerNumbers(db, playerId);
  if (rows.length === 0) return null;
  const t = await getTranslations("stats");
  return (
    <section className="card" data-testid="my-numbers">
      <h2 className="text-lg font-extrabold">{t("mineTitle")}</h2>
      <p className="mt-1 text-xs text-muted">{t("mineLead")}</p>
      <StatTiles rows={bestsOf(rows).slice(0, 3).map((r) => ({ kind: r.kind, value: r.value, margin: r.margin }))} />
      <Link href="/me/stats" prefetch={false} className="link mt-3 inline-block text-sm" data-testid="my-stats-link">
        {t("mineAll")}
      </Link>
    </section>
  );
}
