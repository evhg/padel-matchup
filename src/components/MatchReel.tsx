import { getTranslations } from "next-intl/server";
import type { ReelView } from "@/lib/domain/matchReel";
import { ReelSave } from "./ReelSave";
import { ReelLinkShare } from "./ReelLinkShare";
import { baseUrl, tiktokShareOn } from "@/lib/config";

/**
 * The highlights reel on the match page, for the match's own players and organiser (the page decides).
 * The tall reel plays in place, with the browser's own player, which asks the reel host for parts of the
 * file as it plays. The two buttons save the tall and the wide file through the phone (`ReelSave`).
 */
export async function MatchReel({ reel, keptUntil, code }: { reel: ReelView; keptUntil: string; code: string }) {
  const t = await getTranslations("reel");
  const tt = await getTranslations("tiktok");
  return (
    <section className="card" data-testid="match-reel">
      <h2 className="text-lg font-extrabold">{t("title")}</h2>
      {/* The poster: a frame of the opening, both teams on it, so the page shows a picture and not a black box before
          the reel plays (the owner, 25 November 2026). No "#t=0.1" on the address: that seek takes the poster away in
          Chrome and shows the reel's first frame, which is dark, so the black box stayed after the poster came. */}
      <video className="mx-auto mt-3 block aspect-[9/16] max-h-[70vh] max-w-full rounded-2xl bg-night object-cover" controls playsInline preload="metadata" poster={reel.poster} src={reel.tall} data-testid="reel-video" />
      {/* Saved through the phone's share sheet ("Save Video"), never by leaving the page for the reel host. */}
      <div className="mt-3 flex flex-col gap-2">
        {/* A computer shares the reel page's link; a phone shares the file (`ReelSave`). */}
        <ReelLinkShare url={`${baseUrl()}/${code}/reel?s=share`} text={t("title")} />
        <ReelSave url={reel.tall} name={`kicksmash-${code}-tall.mp4`} primary label={t("downloadTall")} shareLabel={t("shareTall")} />
        <ReelSave url={reel.wide} name={`kicksmash-${code}-wide.mp4`} primary={false} label={t("downloadWide")} shareLabel={t("shareWide")} />
        {/* "Share to TikTok" (the owner, 26 November 2026): the player posts the reel to their own TikTok, through TikTok's sign-in. */}
        {tiktokShareOn() && (
          <a href={`/api/tiktok/start?code=${code}`} className="btn-ghost btn-sm w-full" data-testid="reel-tiktok">
            {tt("share")}
          </a>
        )}
      </div>
      <p className="mt-2 text-xs text-faint">{t("kept", { date: keptUntil })}</p>
    </section>
  );
}
