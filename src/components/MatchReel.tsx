import { getTranslations } from "next-intl/server";
import { MISSING_COPY, type ReelView } from "@/lib/domain/matchReel";
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
  const tm = await getTranslations("reelMissing");
  return (
    <section className="card" data-testid="match-reel">
      <h2 className="text-lg font-extrabold">{t("title")}</h2>
      {/* The poster: a frame of the opening, both teams on it, so the page shows a picture and not a black box before
          the reel plays (the owner, 25 November 2026). No "#t=0.1" on the address: that seek takes the poster away in
          Chrome and shows the reel's first frame, which is dark, so the black box stayed after the poster came. */}
      <video className="mx-auto mt-3 block aspect-[9/16] max-h-[70vh] max-w-full rounded-2xl bg-night object-cover" controls playsInline preload="metadata" poster={reel.poster} src={reel.tall} data-testid="reel-video" />
      {/* What this reel could not do (the owner, 27 November 2026): one row for each thing it lacks, with the reason
          and one tip for the next film, folded under the reel. Nothing when it lacks nothing. */}
      {reel.missing.length > 0 && (
        <details className="group mt-3 border-t border-line pt-1" data-testid="reel-missing">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-semibold">
            {tm("title")}
            <span aria-hidden="true" className="text-faint transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <ul className="divide-y divide-line">
            {reel.missing.map((code) => (
              <li key={code} className="py-3" data-missing={code}>
                <p className="font-semibold">{tm(MISSING_COPY[code].thing)}</p>
                <p className="mt-0.5 text-[0.9375rem] text-muted">{tm(MISSING_COPY[code].why)}</p>
                <p className="mt-1 text-[0.9375rem]">{tm(MISSING_COPY[code].tip)}</p>
              </li>
            ))}
          </ul>
        </details>
      )}
      {/* Saved through the phone's share sheet ("Save Video"), never by leaving the page for the reel host. */}
      <div className="mt-3 flex flex-col gap-2">
        {/* A computer shares the reel page's link; a phone shares the file (`ReelSave`). */}
        <ReelLinkShare url={`${baseUrl()}/${code}/reel?s=share`} text={t("title")} />
        <ReelSave url={reel.tall} name={`kicksmash-${code}-tall.mp4`} primary label={t("downloadTall")} shareLabel={t("shareTall")} />
        <ReelSave url={reel.wide} name={`kicksmash-${code}-wide.mp4`} primary={false} label={t("downloadWide")} shareLabel={t("shareWide")} />
        {/* "Share to TikTok" (the owner, 26 November 2026): the player posts the reel to their own TikTok, through TikTok's sign-in. */}
        {tiktokShareOn(code) && (
          <a href={`/api/tiktok/start?code=${code}`} className="btn-ghost btn-sm w-full" data-testid="reel-tiktok">
            {tt("share")}
          </a>
        )}
      </div>
      <p className="mt-2 text-xs text-faint">{t("kept", { date: keptUntil })}</p>
    </section>
  );
}
