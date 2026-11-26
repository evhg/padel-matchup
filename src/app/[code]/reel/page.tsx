import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { ShareButtons } from "@/components/ShareSheet";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { baseUrl, tiktokKeys } from "@/lib/config";
import { getEventPhotoMeta } from "@/lib/domain/photos";
import { matchReel, reelStillAt } from "@/lib/domain/matchReel";
import { getEventByCode } from "@/lib/domain/queries";
import { callbackWhyOf } from "@/lib/domain/tiktok";
import { cardImagePath, cardVersion, matchLine } from "@/lib/resultCard";
import { taggedUrl } from "@/lib/source";
import { withClientMessages } from "@/i18n/withClientMessages";

const TIKTOK_WHY = { denied: "errDenied", expired: "errExpired", failed: "errFailed", scope: "errScope" } as const;

type Props = { params: Promise<{ code: string }>; searchParams?: Promise<{ tiktok?: string }> };

/**
 * The reel of a match, for anybody with the link (the owner, 25 November 2026: a reel that meets the v8 standard may
 * go public, CLAUDE.md order 10; "on desktop, there is just a download, no share? ... Figure out how to make it
 * work"). A computer shares this page's link, not a file of 100 MB: the link unfurls with the match card in a
 * chat, and the reel plays here. The match page keeps the reel for its players; this page is what they send.
 * Kept out of search. Two reads on indexed keys, the same as the card page.
 */
async function load(code: string) {
  if (!isValidShareCode(code)) return null;
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail || detail.event.type !== "match") return null;
  const reel = await matchReel(db, detail.event.id).catch(() => null);
  return reel ? { db, detail, reel } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code } = await params;
  const got = await load(code);
  if (!got) return {};
  const t = await getTranslations();
  const line = matchLine(t as unknown as (key: string, values?: Record<string, string | number>) => string, got.detail)?.line ?? "";
  const title = line ? `${t("reel.pageTitle")} · ${line}` : t("reel.pageTitle");
  const photo = await getEventPhotoMeta(got.db, got.detail.event.id).catch(() => null);
  const still = photo ? null : await reelStillAt(got.db, got.detail.event.id).catch(() => null);
  const image = { url: `${baseUrl()}${cardImagePath(code, cardVersion(got.detail, photo, still))}`, width: 1200, height: 630 };
  const video = { url: got.reel.tall, type: "video/mp4", width: 1080, height: 1920 };
  return {
    title,
    robots: { index: false, follow: false },
    openGraph: { title, type: "video.other", url: `${baseUrl()}/${code}/reel`, images: [image], videos: [video] },
    twitter: { card: "summary_large_image", title, images: [image.url] },
  };
}

async function ReelPage({ params, searchParams }: Props) {
  const { code } = await params;
  // A TikTok sign-in that came back without a token (`/api/tiktok/callback`): our own words, by the reason's name only.
  const tiktokWhy = callbackWhyOf((await searchParams)?.tiktok);
  const got = await load(code);
  if (!got) notFound();
  const t = await getTranslations();
  const line = matchLine(t as unknown as (key: string, values?: Record<string, string | number>) => string, got.detail)?.line ?? "";
  const url = taggedUrl(`${baseUrl()}/${code}/reel`, "share");
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12" data-testid="reel-page">
        <h1 className="text-2xl font-extrabold tracking-tight">{t("reel.pageTitle")}</h1>
        {line && <p className="text-sm font-semibold">{line}</p>}
        <video className="mx-auto block aspect-[9/16] max-h-[75vh] max-w-full rounded-2xl bg-night object-cover" controls playsInline preload="metadata" poster={got.reel.poster} src={got.reel.tall} data-testid="reel-page-video" />
        <ShareButtons url={url} text={line ? `${t("reel.pageTitle")} · ${line}` : t("reel.pageTitle")} />
        {tiktokKeys() && (
          <>
            {/* "Share to TikTok" (the owner, 26 November 2026): any player posts the reel to their own TikTok. A plain link: nothing goes to TikTok before the player opens it. */}
            <a href={`/api/tiktok/start?code=${code}`} className="btn-secondary w-full" data-testid="tiktok-share">
              {t("tiktok.share")}
            </a>
            {tiktokWhy && (
              <p role="alert" className="px-1 text-[0.9375rem] text-danger" data-testid="tiktok-error">
                {t(`tiktok.${TIKTOK_WHY[tiktokWhy]}`)}
              </p>
            )}
          </>
        )}
        <Link href="/" prefetch={false} className="btn-primary w-full text-lg">
          {t("card.organize")}
        </Link>
        <Link href={`/${code}`} prefetch={false} className="btn-ghost w-full">
          ← {t("card.back")}
        </Link>
      </main>
      <Footer />
    </>
  );
}

export default withClientMessages(["common", "share"], ReelPage);
