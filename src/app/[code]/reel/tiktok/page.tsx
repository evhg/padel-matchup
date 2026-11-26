import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { Footer, Header } from "@/components/Header";
import { TikTokPost } from "@/components/TikTokPost";
import { getDb } from "@/db";
import { isValidShareCode } from "@/lib/codes";
import { tiktokKeys } from "@/lib/config";
import { matchReel } from "@/lib/domain/matchReel";
import { getEventByCode } from "@/lib/domain/queries";
import { needsReconnect, notAllowedYet } from "@/lib/domain/tiktok";
import { matchLine } from "@/lib/resultCard";
import { creatorInfo } from "@/lib/tiktok/api";
import { openToken, TOKEN_COOKIE } from "@/lib/tiktok/seal";
import { shareFileThere } from "@/lib/tiktok/shareFile";
import { withClientMessages } from "@/i18n/withClientMessages";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("tiktok");
  return { title: t("pageTitle"), robots: { index: false, follow: false } };
}

/**
 * The posting page of "Share to TikTok" (TikTok's Content Sharing Guidelines). It reads the creator's account
 * fresh on every render, with the token in the player's cookie, and shows whose account gets the post; the
 * form (`TikTokPost`) sends nothing to TikTok until the player presses Post. A browser with no token goes to
 * TikTok's sign-in first (`/api/tiktok/start`, which comes back here). Kept out of search.
 * Reads: the match (one statement), its reel (one, on its unique index), one HEAD to the reel host for the public
 * version (`share.mp4`, once per render), then TikTok.
 */
async function TikTokPage({ params }: Props) {
  const { code } = await params;
  if (!isValidShareCode(code) || !tiktokKeys()) notFound();
  const db = await getDb();
  const detail = await getEventByCode(db, code);
  if (!detail || detail.event.type !== "match") notFound();
  const now = new Date();
  const reel = await matchReel(db, detail.event.id, now).catch(() => null);
  if (!reel) notFound();
  const t = await getTranslations();
  const back = (
    <Link href={`/${code}/reel`} prefetch={false} className="btn-ghost w-full">
      ← {t("reel.pageTitle")}
    </Link>
  );
  // Only the reel's public version (share.mp4) goes to TikTok. A reel made before TikTok sharing has none: the page
  // says so and offers nothing to post, before any sign-in, so the start never loops back here for a token.
  const share = await shareFileThere(reel.share);
  if (share !== "yes") {
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12" data-testid="tiktok-page">
          <h1 className="text-[1.75rem] font-extrabold tracking-tight">{t("tiktok.pageTitle")}</h1>
          <section className="card" data-testid={share === "no" ? "tiktok-old-reel" : "tiktok-reel-down"}>
            <p className="text-[0.9375rem]">{share === "no" ? t("tiktok.oldReel") : t("tiktok.reelDown")}</p>
          </section>
          {share === "no" && (
            <Link href={`/${code}#reel-again`} prefetch={false} className="btn-secondary w-full" data-testid="tiktok-new-reel">
              {t("reel.againOpen")}
            </Link>
          )}
          {back}
        </main>
        <Footer />
      </>
    );
  }
  const token = openToken((await cookies()).get(TOKEN_COOKIE)?.value, now);
  if (!token) redirect(`/api/tiktok/start?code=${code}`);
  const info = await creatorInfo(token.accessToken);
  if (!info.ok) {
    // TikTok's guideline: when the creator cannot post now, stop and say "try again later", in TikTok's own words too.
    // An account TikTok does not let in yet gets one plain line in place of TikTok's words (`notAllowedYet`).
    const reconnect = needsReconnect(info.error);
    const test = notAllowedYet(info.error.code);
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12" data-testid="tiktok-page">
          <h1 className="text-[1.75rem] font-extrabold tracking-tight">{t("tiktok.pageTitle")}</h1>
          <section className="card" data-testid="tiktok-cannot">
            {test ? (
              <p className="text-[0.9375rem]" data-testid="tiktok-in-test">
                {t("tiktok.inTest")}
              </p>
            ) : (
              <>
                {!reconnect && <p className="mb-1 font-semibold">{t("tiktok.cannotPost")}</p>}
                <p className="text-[0.9375rem] text-muted">{t("tiktok.refused", { message: info.error.message || info.error.code })}</p>
              </>
            )}
          </section>
          {reconnect && (
            <a href={`/api/tiktok/start?code=${code}&again=1`} className="btn-secondary w-full">
              {t("tiktok.reconnect")}
            </a>
          )}
          {back}
        </main>
        <Footer />
      </>
    );
  }
  const title = matchLine(t as unknown as (key: string, values?: Record<string, string | number>) => string, detail)?.line || t("tiktok.titleFallback");
  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-2 pb-12" data-testid="tiktok-page">
        <h1 className="text-[1.75rem] font-extrabold tracking-tight">{t("tiktok.pageTitle")}</h1>
        {/* The preview is the file TikTok gets: the public version, never the tall reel. */}
        <TikTokPost code={code} creator={info.creator} video={reel.share} poster={reel.poster} title={title} />
        {back}
      </main>
      <Footer />
    </>
  );
}

export default withClientMessages(["tiktok"], TikTokPage);
