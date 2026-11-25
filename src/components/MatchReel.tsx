import { getTranslations } from "next-intl/server";
import type { ReelView } from "@/lib/domain/matchReel";
import { ReelSave } from "./ReelSave";

/**
 * The highlights reel on the match page, for the match's own players and organiser (the page decides).
 * The tall reel plays in place, with the browser's own player, which asks the reel host for parts of the
 * file as it plays. The two buttons save the tall and the wide file through the phone (`ReelSave`).
 */
export async function MatchReel({ reel, keptUntil, code }: { reel: ReelView; keptUntil: string; code: string }) {
  const t = await getTranslations("reel");
  return (
    <section className="card" data-testid="match-reel">
      <h2 className="text-lg font-extrabold">{t("title")}</h2>
      {/* The poster: a frame of the opening, both teams on it, so the page shows a picture and not a black box before
          the reel plays (the owner, 25 November 2026). #t=0.1 still helps an iPhone where a reel has no poster. */}
      <video className="mx-auto mt-3 block aspect-[9/16] max-h-[70vh] max-w-full rounded-2xl bg-night object-cover" controls playsInline preload="metadata" poster={reel.poster} src={`${reel.tall}#t=0.1`} data-testid="reel-video" />
      {/* Saved through the phone's share sheet ("Save Video"), never by leaving the page for the reel host. */}
      <div className="mt-3 flex flex-col gap-2">
        <ReelSave url={reel.tall} name={`kicksmash-${code}-tall.mp4`} primary label={t("downloadTall")} shareLabel={t("shareTall")} />
        <ReelSave url={reel.wide} name={`kicksmash-${code}-wide.mp4`} primary={false} label={t("downloadWide")} shareLabel={t("shareWide")} />
      </div>
      <p className="mt-2 text-xs text-faint">{t("kept", { date: keptUntil })}</p>
    </section>
  );
}
