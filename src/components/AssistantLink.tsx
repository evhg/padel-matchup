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

type Door = { key: string; href: string; label: string; kind: "coach" | "club" | "series" | "public"; testId: string };
export type NavLabels = { myMatches: string; assistant: string; club: string; series: string; more: string; coaches: string; clubs: string; tournaments: string };

/**
 * The public doors every visitor gets, in the More menu: the coaches' directory, the clubs' page
 * with the claim, the tournaments. They used to be reachable only by URL or from a city page, which
 * is how a club owner or a serious organiser arrived on kicksma.sh and saw only the match form.
 */
const publicDoors = (labels: NavLabels): Door[] => [
  { key: "coaches", href: "/coaches", label: labels.coaches, kind: "public", testId: "nav-coaches" },
  { key: "clubs", href: "/clubs", label: labels.clubs, kind: "public", testId: "nav-clubs" },
  { key: "tournaments", href: "/t", label: labels.tournaments, kind: "public", testId: "nav-tournaments" },
];

export function HeaderNav({ roles, current, labels }: { roles: RoleSet; current?: "play" | "coach" | "club" | "series"; labels: NavLabels }) {
  const doors: Door[] = [];
  if (roles.coach) doors.push({ key: "coach", href: "/coach", label: `🎾 ${labels.assistant}`, kind: "coach", testId: "assistant-link" });
  for (const c of roles.clubs) doors.push({ key: `club-${c.slug}`, href: `/v/${c.slug}`, label: roles.clubs.length === 1 ? labels.club : c.name, kind: "club", testId: "nav-club" });
  for (const s of roles.series) doors.push({ key: `series-${s.slug}`, href: `/s/${s.slug}`, label: roles.series.length === 1 ? labels.series : s.name, kind: "series", testId: "nav-series" });

  const link = (d: Door) => (
    <Link key={d.key} href={d.href} prefetch={false} className={chip} data-testid={d.testId}>
      {d.label}
    </Link>
  );
  const play = (
    <Link href="/me" prefetch={false} className={chip} data-testid="nav-play">
      {labels.myMatches}
    </Link>
  );
  // The menu is one short glyph, so the header keeps its one word beside it on a phone. Inside: the
  // way to My matches when this is not it, every role door not shown outside, then the public three.
  const more = (inside: React.ReactNode[]) => (
    <details className="relative">
      <summary className={`${chip} list-none cursor-pointer`} data-testid="nav-more" aria-label={labels.more} title={labels.more}>
        ⋯
      </summary>
      <div className="absolute right-0 z-20 mt-1 flex min-w-40 flex-col gap-1 rounded-xl border border-line bg-white p-2 shadow-lg">
        {inside}
        <div className="my-1 border-t border-line" />
        {publicDoors(labels).map(link)}
      </div>
    </details>
  );

  // A player, and anyone we have never met: My matches, and the menu with the public doors.
  if (doors.length === 0)
    return (
      <>
        {play}
        {more([])}
      </>
    );

  // One other role: outside, whichever of the two this screen is not; the other one waits in the menu.
  if (doors.length === 1) {
    const d = doors[0];
    const outside = current === d.kind ? play : link(d);
    const inside = current === d.kind ? [] : current === "play" ? [] : [play];
    return (
      <>
        {outside}
        {more(inside)}
      </>
    );
  }

  // Several roles: the menu alone, with every door in it.
  return more([...(current !== "play" ? [play] : []), ...doors.map(link)]);
}
