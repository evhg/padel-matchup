import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getViewer } from "@/actions/shared";
import { EmailField } from "@/components/EmailField";
import { Header } from "@/components/Header";
import { HomeScreenPrompt } from "@/components/HomeScreenPrompt";
import { PushToggle } from "@/components/PushToggle";
import { ScrollTop } from "@/components/ScrollTop";
import { CopyButton, LinkBox, QrPanel, ShareButtons } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, emailEnabled, shortHost } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isClaimable } from "@/lib/domain/events";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { playerHasPush } from "@/lib/domain/push";
import { pushEnabled, vapidPublicKey } from "@/lib/push";
import { getEventByCode } from "@/lib/domain/queries";
import { venueWithCourt } from "@/lib/labels";
import { personalPath } from "@/lib/personal";
import { eventUrl, manageUrl } from "@/lib/share";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const t = await getTranslations();
  let tournament = false;
  if (isValidShareCode(code)) {
    const db = await getDb();
    tournament = (await getEventByCode(db, code))?.event.type === "tournament";
  }
  return { title: t(tournament ? "share.titleTournament" : "share.titleMatch"), robots: { index: false } };
}

export default async function SharePage({ params }: Props) {
  const { code } = await params;
  if (!isValidShareCode(code)) notFound();
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail) notFound();
  const viewer = await getViewer(db, detail);
  if (!viewer.isCreator) redirect(`/${code}`);
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const ev = detail.event;
  const isTournament = ev.type === "tournament";
  const url = eventUrl(baseUrl(), code);
  const spotsLeft = detail.roster.filter(isClaimable).length;
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const time = formatEventTime(ev.startsAt, ev.tz, locale);
  const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) });
  const text = t("shareText.event", { day, time, venue, spots: t("shareText.spotsLeft", { count: spotsLeft }), url });
  const mUrl = manageUrl(baseUrl(), code, ev.manageCode);
  const token = viewer.player ? await getOrCreatePersonalToken(db, viewer.player.id) : null;
  const hasPush = viewer.player && pushEnabled() ? await playerHasPush(db, viewer.player.id) : false;

  return (
    <>
      <ScrollTop />
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12 [overflow-anchor:none]">
        <section className="text-center">
          <div className="mx-auto inline-grid h-14 w-14 place-items-center rounded-full bg-accent text-2xl">{isTournament ? "🏆" : "🎾"}</div>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{t(isTournament ? "share.titleTournament" : "share.titleMatch")}</h1>
          <p className="mt-1 text-muted">{t(isTournament ? "share.subtitleTournament" : "share.subtitle")}</p>
        </section>
        <LinkBox url={url} display={`${shortHost()}/${code}`} />
        <ShareButtons url={url} text={text} />
        <section className="card">
          <QrPanel url={url} hint={t("share.qrHint")} />
        </section>
        <Link href={`/${code}`} prefetch={false} className="btn-secondary w-full text-lg">
          {t(isTournament ? "share.openTournament" : "share.openMatch")} →
        </Link>

        {viewer.player && pushEnabled() && (
          <section className="card">
            <PushToggle vapidPublicKey={vapidPublicKey()} subscribed={hasPush} />
          </section>
        )}
        <HomeScreenPrompt personalPath={token ? personalPath(token) : null} installed={Boolean(viewer.player?.homescreenAt)} />

        {emailEnabled() && (
          <section className="card">
            <EmailField initial={detail.creator.email} mode="creator" code={code} title={t("share.emailTitle")} help={t("share.emailHelp")} emailEnabled notifyOn={detail.creator.emailNotifications} />
          </section>
        )}

        <section className="card">
          <h2 className="font-extrabold">{t("share.manageTitle")}</h2>
          <p className="mt-0.5 text-sm text-muted">{t("share.manageHint")}</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-xl bg-bg px-3 py-2.5 text-xs">{mUrl}</code>
            <CopyButton value={mUrl} label={t("common.copy")} className="btn-ghost btn-sm" />
          </div>
        </section>
      </main>
    </>
  );
}
