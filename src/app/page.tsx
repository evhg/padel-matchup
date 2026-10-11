import type { Metadata } from "next";
import { localeAlternates } from "@/lib/seo";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { CreateScreen } from "@/components/CreateScreen";
import { FeedbackInline } from "@/components/FeedbackInline";
import { PasteBooking } from "@/components/PasteBooking";
import { PASTE_TEXT_MAX } from "@/lib/domain/bookingPaste";
import { screenshotOffered } from "@/lib/booking/screenshot";
import { getDb } from "@/db";
import { Footer, Header } from "@/components/Header";
import { withClientMessages } from "@/i18n/withClientMessages";

/**
 * The paste box's "Add screenshot" waits on one model call (`readScreenshotAction`, 20 seconds at most),
 * and a server action runs in this page's function. Every other request here ends in well under a second,
 * so the longer ceiling costs nothing for them.
 */
export const maxDuration = 30;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  const locale = await getLocale();
  return { title: t("landing.metaTitle"), description: t("landing.metaDescription"), alternates: localeAlternates("/", locale), openGraph: { title: t("landing.metaTitle"), description: t("landing.metaDescription"), type: "website", url: "/" } };
}

/**
 * The landing page is the create form. `?type=tournament&capacity=8` prefills it (used by the /americano
 * generator); `?venue=…&date=…&time=…&tz=…` is a club's free court; `?src=paste&…&len=&court=&cost=&booked=1`
 * is a pasted booking (`bookingHref`), which "Booked already? Paste it" under the headline opens.
 */
async function Home({ searchParams }: { searchParams: Promise<{ type?: string; capacity?: string; group?: string; venue?: string; date?: string; time?: string; tz?: string; tg?: string; dc?: string; names?: string; src?: string; len?: string; court?: string; cost?: string; booked?: string; check?: string; invite?: string }> }) {
  const [t, sp] = await Promise.all([getTranslations(), searchParams]);
  // "Add screenshot" only while a read could go: not while the key is refused (one look per instance every five minutes).
  const shot = await screenshotOffered(await getDb());
  return (
    <>
      <Header />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2">
        <CreateScreen
          heading={t("landing.formTitle")}
          // Decision C (9 October 2026): one compact chip to the open games, under the headline. It
          // must not push the form down by more than a line on a phone, so it is a pill, not a card.
          // "Booked already? Paste it" shares that line as a quiet link (the owner, 11 October 2026),
          // and opens its box under the line only when tapped.
          below={
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <Link href="/play" prefetch={false} className="inline-flex h-7 items-center gap-1 rounded-full bg-accent-soft px-3 text-sm font-bold text-ink hover:bg-accent hover:text-night" data-testid="landing-find-game">
                🔎 {t("common.findGame")} →
              </Link>
              <PasteBooking max={PASTE_TEXT_MAX} shot={shot} />
            </div>
          }
          prefill={{ type: sp.type, capacity: sp.capacity, group: sp.group, venue: sp.venue, date: sp.date, time: sp.time, tz: sp.tz, tg: sp.tg, dc: sp.dc, names: sp.names, src: sp.src, len: sp.len, court: sp.court, cost: sp.cost, booked: sp.booked, check: sp.check, invite: sp.invite }} />
        <section className="mt-6 grid gap-2">
          {[t("landing.step1"), t("landing.step2"), t("landing.step3")].map((s, i) => (
            <div key={i} className="flex items-center gap-3 px-1 text-sm text-muted">
              <span className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-night text-xs font-extrabold text-accent">{i + 1}</span>
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
              <Link key={d.href} href={d.href} prefetch={false} className="flex flex-col gap-1 rounded-2xl border border-line bg-card px-4 py-3 transition hover:border-ink/30" data-testid={d.testId}>
                <span className="text-xl" aria-hidden>
                  {d.icon}
                </span>
                <span className="font-extrabold leading-tight">{d.title}</span>
                <span className="text-xs leading-snug text-muted">{d.line}</span>
              </Link>
            ))}
          </div>
        </section>
        <section className="mt-8">
          <FeedbackInline variant="line" signedInVia="none" help={t("landing.feedbackHelp")} />
        </section>
      </main>
      <Footer spacious />
    </>
  );
}

export default withClientMessages(["common", "create", "errors", "event", "feedback", "identity", "landing", "level", "levelCheck", "pairs", "share", "telegram", "venue"], Home);
