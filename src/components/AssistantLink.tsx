import Link from "next/link";
import type { RoleSet } from "@/lib/domain/roles";

/**
 * The one door in the header, chosen from the roles this person actually holds.
 *
 * It used to be a single link whose destination a browser cookie decided, which is how a player who
 * had never coached was shown a coach's button: the cookie outlived the role that set it. The role
 * set is read on the server now, so the header cannot be wrong about who someone is, and a role that
 * ends stops showing in the same breath.
 *
 * It stays one chip. The header already carries a logo and a language toggle, and on a phone there
 * is room for nothing else — two chips overlap the logo and push the toggle off the screen. So the
 * header offers the way *out*: the door you are not standing in. Someone who holds several roles
 * gets one word, More, that opens the rest as an ordinary list.
 */

const chip = "btn-ghost btn-xs";

type Door = { key: string; href: string; label: string; kind: "coach" | "club" | "series"; testId: string };

export function HeaderNav({ roles, current, labels }: { roles: RoleSet; current?: "play" | "coach" | "club" | "series"; labels: { myMatches: string; assistant: string; club: string; series: string; more: string } }) {
  const doors: Door[] = [];
  if (roles.coach) doors.push({ key: "coach", href: "/coach", label: `🎾 ${labels.assistant}`, kind: "coach", testId: "assistant-link" });
  for (const c of roles.clubs) doors.push({ key: `club-${c.slug}`, href: `/v/${c.slug}`, label: roles.clubs.length === 1 ? labels.club : c.name, kind: "club", testId: "nav-club" });
  for (const s of roles.series) doors.push({ key: `series-${s.slug}`, href: `/s/${s.slug}`, label: roles.series.length === 1 ? labels.series : s.name, kind: "series", testId: "nav-series" });

  const play = (
    <Link href="/me" prefetch={false} className={chip} data-testid="nav-play">
      {labels.myMatches}
    </Link>
  );

  // A player, and anyone we have never met: exactly what the header always showed.
  if (doors.length === 0) return play;

  // One other role: show whichever of the two this screen is not.
  if (doors.length === 1) {
    const d = doors[0];
    if (current === d.kind) return play;
    return (
      <Link href={d.href} prefetch={false} className={chip} data-testid={d.testId}>
        {d.label}
      </Link>
    );
  }

  // Several: one word, and the doors underneath it.
  return (
    <details className="relative">
      <summary className={`${chip} list-none cursor-pointer`} data-testid="nav-more">
        {labels.more}
      </summary>
      <div className="absolute right-0 z-20 mt-1 flex min-w-40 flex-col gap-1 rounded-xl border border-line bg-white p-2 shadow-lg">
        {current !== "play" && play}
        {doors.map((d) => (
          <Link key={d.key} href={d.href} prefetch={false} className={chip} data-testid={d.testId}>
            {d.label}
          </Link>
        ))}
      </div>
    </details>
  );
}
