import type { Metadata } from "next";
import { localeAlternates } from "@/lib/seo";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CreateScreen } from "@/components/CreateScreen";
import { Footer, Header } from "@/components/Header";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const locale = await getLocale();
  return { title: t("landing.metaTitle"), description: t("landing.metaDescription"), alternates: localeAlternates("/", locale), openGraph: { title: t("landing.metaTitle"), description: t("landing.metaDescription"), type: "website", url: "/" } };
}

/** The landing page is the create form. `?type=tournament&capacity=8` prefills it (used by the /americano generator). */
export default async function Home({ searchParams }: { searchParams: Promise<{ type?: string; capacity?: string; group?: string; venue?: string; tg?: string; dc?: string; names?: string }> }) {
  const [t, sp] = await Promise.all([getTranslations(), searchParams]);
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <CreateScreen heading={t("landing.formTitle")} sub={t("landing.formSub")} prefill={{ type: sp.type, capacity: sp.capacity, group: sp.group, venue: sp.venue, tg: sp.tg, dc: sp.dc, names: sp.names }} />
        <section className="mt-6 grid gap-2">
          {[t("landing.step1"), t("landing.step2"), t("landing.step3")].map((s, i) => (
            <div key={i} className="flex items-center gap-3 px-1 text-sm text-muted">
              <span className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-ink text-xs font-extrabold text-accent">{i + 1}</span>
              <span className="font-semibold">{s}</span>
            </div>
          ))}
        </section>
        {/* The other four people this is for, one door each: a tile with a name and the one line that
            says who it is for. Four lines of links at the bottom of the page were a footer, not a door. */}
        <section className="mt-6" aria-label={t("landing.doorsTitle")} data-testid="landing-doors">
          <h2 className="px-1 text-xs font-bold uppercase tracking-wider text-faint">{t("landing.doorsTitle")}</h2>
          <div className="mt-2 grid grid-cols-2 gap-2">
            {[
              { href: "/coaches?s=landing", icon: "🎾", title: t("common.coaches"), line: t("landing.doorFindCoach"), testId: "landing-coaches" },
              { href: "/t", icon: "🏆", title: t("common.tournaments"), line: t("landing.doorTournaments"), testId: "landing-tournaments" },
              { href: "/clubs", icon: "🏟", title: t("common.clubs"), line: t("landing.doorClubs"), testId: "landing-clubs" },
              { href: "/americano", icon: "🔀", title: t("landing.americanoTitle"), line: t("landing.doorAmericano"), testId: "landing-americano" },
            ].map((d) => (
              <Link key={d.href} href={d.href} prefetch={false} className="flex flex-col gap-1 rounded-2xl border border-line bg-white px-4 py-3 transition hover:border-ink/30" data-testid={d.testId}>
                <span className="text-xl" aria-hidden>
                  {d.icon}
                </span>
                <span className="font-extrabold leading-tight">{d.title}</span>
                <span className="text-xs leading-snug text-muted">{d.line}</span>
              </Link>
            ))}
          </div>
        </section>
      </main>
      <Footer spacious />
    </>
  );
}
