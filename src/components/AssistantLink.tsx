import Link from "next/link";
import type { RoleSet } from "@/lib/domain/roles";
import { roleCount } from "@/lib/domain/roles";

/**
 * The doors in the header, one per role this person actually holds.
 *
 * This used to be a single link whose destination a browser cookie decided, which is how a player
 * who had never coached was shown a coach's button: the cookie outlived the role that set it, and
 * almost nothing cleared it. The role set is read on the server now, so the header cannot be wrong
 * about who someone is, and a role that ends stops showing in the same breath.
 *
 * It changes shape rather than growing, because a phone header has a logo and a language toggle in
 * it already: nothing, one link, two links, or one link and everything else behind "More".
 */

const chip = "btn-ghost btn-xs";
const here = "btn-secondary btn-xs";

export function HeaderNav({ roles, current, labels }: { roles: RoleSet; current?: "play" | "coach" | "club" | "series"; labels: { myMatches: string; assistant: string; club: string; series: string; more: string } }) {
  const extras = roleCount(roles);

  // Nobody we know: the way in sits at the foot of the page, not in the header. A personal link
  // that leads to an empty room is worse than no link at all.
  if (extras === 0 && roles.studentOf === 0) {
    return (
      <Link href="/me" prefetch={false} className={chip}>
        {labels.myMatches}
      </Link>
    );
  }

  const play = (
    <Link href="/me" prefetch={false} className={current === "play" ? here : chip} data-testid="nav-play">
      {labels.myMatches}
    </Link>
  );

  if (extras === 0) return play;

  const doors: React.ReactNode[] = [];
  if (roles.coach)
    doors.push(
      <Link key="coach" href="/coach" prefetch={false} className={current === "coach" ? here : chip} data-testid="assistant-link">
        🎾 {labels.assistant}
      </Link>,
    );
  for (const c of roles.clubs)
    doors.push(
      <Link key={`club-${c.slug}`} href={`/v/${c.slug}`} prefetch={false} className={current === "club" ? here : chip} data-testid="nav-club">
        {roles.clubs.length === 1 ? labels.club : c.name}
      </Link>,
    );
  for (const s of roles.series)
    doors.push(
      <Link key={`series-${s.slug}`} href={`/s/${s.slug}`} prefetch={false} className={current === "series" ? here : chip} data-testid="nav-series">
        {roles.series.length === 1 ? labels.series : s.name}
      </Link>,
    );

  // One extra door fits beside Play. More than one and the header runs out of phone, so the rest
  // go under a single word that opens them as an ordinary list.
  if (doors.length === 1)
    return (
      <>
        {play}
        {doors[0]}
      </>
    );
  return (
    <>
      {play}
      <details className="relative">
        <summary className={`${chip} list-none cursor-pointer`} data-testid="nav-more">
          {labels.more}
        </summary>
        <div className="absolute right-0 z-20 mt-1 flex min-w-40 flex-col gap-1 rounded-xl border border-line bg-white p-2 shadow-lg">{doors}</div>
      </details>
    </>
  );
}
