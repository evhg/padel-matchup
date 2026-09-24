import { cookies } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";
import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { formatEventDay } from "@/lib/dates";
import { proved, sameNameMatches, sameNameRows } from "@/lib/domain/sameName";
import { SameNameButtons } from "./SameNameButtons";

/** The cookie that remembers "Not me", per browser: ids of rows this person said are somebody else. */
export const NOT_MINE_COOKIE = "ks_notmine";

/**
 * "Are these yours?": matches played under this person's name from a browser that never gave an
 * address. Offered only to a person who proved who they are, with the matches themselves shown, so
 * the answer is theirs to give with the facts in front of them (the owner's option A, 24 September
 * 2026). A row that shares a match, an organiser or a club was already folded in at the moment of
 * proof; what reaches this card is the rest.
 */
export async function SameNameCard({ db, player }: { db: Db; player: Player }) {
  if (!proved(player)) return null;
  const jar = await cookies();
  const notMine = new Set((jar.get(NOT_MINE_COOKIE)?.value ?? "").split(",").filter(Boolean));
  const rows = (await sameNameRows(db, player.id)).filter((r) => !notMine.has(r.id));
  if (rows.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations("me"), getLocale()]);
  const matches = await sameNameMatches(db, rows.map((r) => r.id));
  return (
    <section className="card" data-testid="same-name">
      <h2 className="text-lg font-extrabold">{t("sameTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("sameHelp", { name: player.displayName })}</p>
      <ul className="mt-3 flex flex-col gap-3">
        {rows.map((r) => (
          <li key={r.id} className="rounded-2xl border border-line p-3" data-testid={`same-name-${r.id}`}>
            <div className="font-bold">{t("sameCount", { count: r.matches })}</div>
            <ul className="mt-1 flex flex-col gap-0.5 text-sm text-muted">
              {(matches.get(r.id) ?? []).map((m) => (
                <li key={m.code}>
                  {formatEventDay(m.startsAt, m.tz, locale)} · {m.venue ?? t("sameNoVenue")}
                  {m.with.length > 0 ? ` · ${t("sameWith", { names: m.with.join(", ") })}` : ""}
                </li>
              ))}
            </ul>
            <SameNameButtons rowId={r.id} notMine={[...notMine]} />
          </li>
        ))}
      </ul>
    </section>
  );
}
