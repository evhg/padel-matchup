import { getTranslations } from "next-intl/server";
import type { ReelView } from "@/lib/domain/matchReel";

/**
 * The highlights reel on the match page, for the match's own players and organiser (the page decides).
 * The tall reel plays in place; the two links save the tall and the wide file. No client code: the
 * browser's own player does the work, and it asks the reel host for parts of the file as it plays.
 */
export async function MatchReel({ reel, keptUntil }: { reel: ReelView; keptUntil: string }) {
  const t = await getTranslations("reel");
  return (
    <section className="card" data-testid="match-reel">
      <h2 className="text-lg font-extrabold">{t("title")}</h2>
      {/* #t=0.1: an iPhone shows a first picture only when the address asks for a moment of the film. */}
      <video className="mx-auto mt-3 block aspect-[9/16] max-h-[70vh] max-w-full rounded-2xl bg-night" controls playsInline preload="metadata" src={`${reel.tall}#t=0.1`} data-testid="reel-video" />
      <div className="mt-3 flex flex-col gap-2">
        <a className="btn-secondary btn-sm w-full" href={reel.saveTall} data-testid="reel-save-tall">
          {t("saveTall")}
        </a>
        <a className="btn-ghost btn-sm w-full" href={reel.saveWide} data-testid="reel-save-wide">
          {t("saveWide")}
        </a>
      </div>
      <p className="mt-2 text-xs text-faint">{t("kept", { date: keptUntil })}</p>
    </section>
  );
}
