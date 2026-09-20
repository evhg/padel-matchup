import Link from "next/link";
import { getTranslations } from "next-intl/server";

export type StageKey = "entries" | "draw" | "courts" | "live" | "results";
export type Stage = { key: StageKey; href: string; done: boolean; /** A short figure under the name: "6 pairs", "1/2". */ count?: string | null };

/**
 * How a weekend runs, at the top of the desk: entries, the draw, courts and times, live, results.
 * Each stage is a link to where it happens, the done ones ticked, the next one lit, and one line
 * under the row says what that next stage takes. The desk had the right tools in the right order
 * and nothing that said the order; the organiser in the walk found it by trying.
 */
export async function WeekendStrip({ stages }: { stages: Stage[] }) {
  const t = await getTranslations("tournament.strip");
  const next = stages.findIndex((s) => !s.done);
  return (
    <section className="card" data-testid="weekend-strip" aria-label={t("title")}>
      <h2 className="text-xs font-bold uppercase tracking-wider text-faint">{t("title")}</h2>
      <ol className="mt-3 grid grid-cols-5 gap-1 sm:gap-2">
        {stages.map((s, i) => {
          const lit = i === next;
          return (
            <li key={s.key} className="min-w-0">
              <Link
                href={s.href}
                prefetch={false}
                className={`flex h-full flex-col items-center gap-1 rounded-2xl px-1 py-2 text-center transition ${lit ? "bg-ink text-white" : s.done ? "bg-bg text-ink" : "text-muted hover:bg-bg"}`}
                data-testid={`stage-${s.key}`}
                data-done={s.done ? "1" : "0"}
                aria-current={lit ? "step" : undefined}
              >
                <span className={`inline-grid h-6 w-6 place-items-center rounded-full text-xs font-extrabold ${s.done ? "bg-ok text-white" : lit ? "bg-accent text-ink" : "bg-line text-muted"}`} aria-hidden>
                  {s.done ? "✓" : i + 1}
                </span>
                <span className="text-xs font-bold leading-tight">{t(s.key)}</span>
                {s.count && <span className={`text-[11px] leading-tight tabular-nums ${lit ? "text-white/80" : "text-faint"}`}>{s.count}</span>}
              </Link>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-xs text-muted" data-testid="stage-hint">
        {next === -1 ? t("allDone") : t(`hint.${stages[next].key}`)}
      </p>
    </section>
  );
}
