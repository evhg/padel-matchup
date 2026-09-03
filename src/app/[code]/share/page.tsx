import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { getViewer } from "@/actions/shared";
import { EmailField } from "@/components/EmailField";
import { Header } from "@/components/Header";
import { CopyButton, LinkBox, QrPanel, ShareButtons } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, emailEnabled, shortHost } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isClaimable } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { eventUrl, manageUrl } from "@/lib/share";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t("share.title"), robots: { index: false } };
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
  const url = eventUrl(baseUrl(), code);
  const spotsLeft = detail.roster.filter(isClaimable).length;
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const time = formatEventTime(ev.startsAt, ev.tz, locale);
  const text = t("shareText.event", { day, time, venue: ev.venueName, spots: t("shareText.spotsLeft", { count: spotsLeft }), url });
  const mUrl = manageUrl(baseUrl(), code, ev.manageCode);

  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12">
        <section className="text-center">
          <div className="mx-auto inline-grid h-14 w-14 place-items-center rounded-full bg-accent text-2xl">🎾</div>
          <h1 className="mt-3 text-3xl font-extrabold tracking-tight">{t("share.title")}</h1>
          <p className="mt-1 text-muted">{t("share.subtitle")}</p>
        </section>
        <LinkBox url={url} display={`${shortHost()}/${code}`} />
        <ShareButtons url={url} text={text} />
        <section className="card">
          <QrPanel url={url} hint={t("share.qrHint")} />
        </section>
        <Link href={`/${code}`} className="btn-secondary w-full text-lg">
          {t("share.openEvent")} →
        </Link>

        {emailEnabled() && (
          <section className="card">
            <EmailField initial={detail.creator.email} mode="creator" code={code} title={t("share.emailTitle")} help={t("share.emailHelp")} emailEnabled />
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
