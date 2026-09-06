import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { getDb } from "@/db";
import { baseUrl } from "@/lib/config";
import { bandOf, formatLevel, isLevelVerified } from "@/lib/domain/levels";
import { getPublicPlayer, profileStats } from "@/lib/domain/profile";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const t = await getTranslations();
  const db = await getDb();
  const p = await getPublicPlayer(db, slug);
  if (!p) return { title: t("passport.title"), robots: { index: false } };
  const title = p.level != null ? t("passport.profileTitle", { name: p.displayName, level: formatLevel(p.level) }) : t("passport.profileTitleNoLevel", { name: p.displayName });
  const description = t("passport.metaDescription", { name: p.displayName });
  return { title, description, alternates: { canonical: `/u/${slug}` }, openGraph: { title, description, type: "profile", url: `${baseUrl()}/u/${slug}` } };
}

/** The public page a player chose to have: first name, level, results, clubs, and the signed document. Nothing else. */
export default async function PublicProfilePage({ params }: Props) {
  const { slug } = await params;
  const db = await getDb();
  const p = await getPublicPlayer(db, slug);
  if (!p) notFound();
  const [t, locale, stats] = await Promise.all([getTranslations(), getLocale(), profileStats(db, p)]);
  const verified = isLevelVerified(p);
  const since = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(stats.since);
  const rows = [
    { label: t("level.stats.played"), value: String(stats.played) },
    { label: t("level.stats.won"), value: String(stats.won) },
    { label: t("level.stats.winRate"), value: stats.decided ? `${Math.round((stats.won / stats.decided) * 100)}%` : "—" },
    { label: t("level.stats.podiums"), value: String(stats.podiums) },
  ];
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="card">
          <span className="chip-muted">🪪 {t("passport.title")}</span>
          <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{p.displayName}</h1>
          <div className="mt-3 flex items-end gap-3">
            <div className="text-5xl font-extrabold tabular-nums leading-none">{p.level != null ? formatLevel(p.level) : "—"}</div>
            <div className="pb-1 text-sm text-muted">
              {p.level == null ? t("passport.noLevel") : <span className="block font-bold">{t(`level.bands.${bandKey(p.level)}`)}</span>}
              {p.level != null && <span className="block text-xs">{verified ? `✓ ${t("passport.verifiedBy")}` : p.levelSource === "adjusted" ? t("passport.adjusted") : t("passport.selfDeclared")}</span>}
            </div>
          </div>
          <p className="mt-3 text-xs text-faint">{t("passport.memberSince", { date: since })}</p>
        </section>

        <section className="card">
          <div className="grid grid-cols-4 gap-2 text-center">
            {rows.map((s) => (
              <div key={s.label}>
                <div className="text-xl font-extrabold tabular-nums">{s.value}</div>
                <div className="text-[11px] font-bold uppercase tracking-wider text-faint">{s.label}</div>
              </div>
            ))}
          </div>
          {stats.clubs.length > 0 && (
            <div className="mt-4 border-t border-line pt-3">
              <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("passport.playsAt")}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {stats.clubs.map((c) => (
                  <Link key={c.slug} href={`/v/${c.slug}`} prefetch={false} className="chip-muted hover:bg-line">
                    {c.name}
                  </Link>
                ))}
              </div>
            </div>
          )}
        </section>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <a href={`/u/${slug}/passport.json`} className="link">
            🔏 {t("passport.signed")}
          </a>
          <Link href="/developers#passport" prefetch={false} className="link">
            {t("passport.verify")} →
          </Link>
          <Link href="/" prefetch={false} className="link">
            + {t("common.newMatch")}
          </Link>
        </div>
      </main>
      <Footer />
    </>
  );
}

const bandKey = (level: number) => bandOf(level);
