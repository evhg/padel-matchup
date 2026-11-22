import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { HeartRateSwitch } from "@/components/HeartRateSwitch";
import { StatTiles, pairName } from "@/components/StatTiles";
import { getDb } from "@/db";
import { bestsOf } from "@/lib/domain/matchStatKinds";
import { playerNumbers, type PlayerStat } from "@/lib/domain/matchStats";
import { getSessionPlayer, signedInByName } from "@/lib/session";
import { withClientMessages } from "@/i18n/withClientMessages";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("stats");
  return { title: t("mineTitle"), robots: { index: false } };
}

/**
 * My stats (the owner, 22 November 2026): the player's bests, then every filmed match with its
 * numbers, then the one switch that is theirs alone, "Keep my heart rate". A browser that is signed
 * in by name only reads: the yes to health data belongs to a session that proved who it is.
 */
async function MyStatsPage() {
  const db = await getDb();
  const me = await getSessionPlayer(db);
  if (!me) redirect("/me");
  const rows = await playerNumbers(db, me.id);
  const byName = await signedInByName(me.id);
  const [t, locale] = await Promise.all([getTranslations("stats"), getLocale()]);
  const day = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short", year: "numeric" });
  const matches = new Map<string, PlayerStat[]>();
  for (const r of rows) matches.set(r.code, [...(matches.get(r.code) ?? []), r]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <h1 className="text-3xl font-extrabold tracking-tight">{t("mineTitle")}</h1>
        {rows.length === 0 ? (
          <section className="card">
            <p className="text-sm text-muted" data-testid="my-stats-empty">
              {t("mineEmpty")}
            </p>
          </section>
        ) : (
          <>
            <section className="card" data-testid="my-bests">
              <h2 className="text-lg font-extrabold">{t("bests")}</h2>
              <StatTiles rows={bestsOf(rows).map((r) => ({ kind: r.kind, value: r.value, margin: r.margin, note: day.format(r.startsAt) }))} />
            </section>
            <section className="card" data-testid="my-stats-matches">
              <h2 className="text-lg font-extrabold">{t("byMatch")}</h2>
              <ul className="mt-1 divide-y divide-line">
                {[...matches.entries()].map(([code, list]) => (
                  <li key={code} className="py-3">
                    <Link href={`/${code}`} prefetch={false} className="link text-sm font-semibold">
                      {day.format(list[0].startsAt)}
                      {list[0].venueName ? ` · ${list[0].venueName}` : ""}
                    </Link>
                    <StatTiles rows={list.map((r) => ({ kind: r.kind, value: r.value, margin: r.margin, who: r.partnerName ? pairName(r.name, r.partnerName) : null }))} />
                  </li>
                ))}
              </ul>
            </section>
          </>
        )}
        {!byName && (
          <section className="card">
            <HeartRateSwitch initial={me.shareHeartRate} />
          </section>
        )}
        <Link href="/me" prefetch={false} className="link text-sm">
          ← {t("back")}
        </Link>
      </main>
      <Footer />
    </>
  );
}

export default withClientMessages(["stats"], MyStatsPage);
