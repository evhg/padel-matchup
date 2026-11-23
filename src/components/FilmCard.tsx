import Link from "next/link";
import { getTranslations } from "next-intl/server";

/**
 * "Film this match. Get a reel.": the dark block a match's own players see before the match starts, and
 * the way to the four instructions on `/film`. No client code, no read: the page decides who sees it.
 * The block is dark in both themes, so its one button is white, never a second lime button on the page.
 */
export async function FilmCard({ code }: { code: string }) {
  const t = await getTranslations("film");
  return (
    <section className="rounded-3xl border border-white/10 bg-night p-5 text-white" data-testid="film-card">
      <h2 className="text-xl font-extrabold leading-tight">{t("cardTitle")}</h2>
      <p className="mt-2 text-sm text-white/80">{t("cardBody")}</p>
      <Link href={`/film?m=${code}`} prefetch={false} className="btn mt-4 w-full bg-white text-night hover:bg-white/90" data-testid="film-how">
        {t("cardCta")}
      </Link>
      <p className="mt-2 text-center text-xs text-white/70">{t("cardNote")}</p>
    </section>
  );
}
