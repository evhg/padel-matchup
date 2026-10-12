import Link from "next/link";
import type { RoleSet } from "@/lib/domain/roles";
import { InboxBell } from "./InboxBell";
import { TextSizeSwitch } from "./TextSizeSwitch";

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
/** `updates`: the unread notices as words ("2 new updates"), the name of the bell; empty when there are none. */
export type NavLabels = { myMatches: string; assistant: string; club: string; series: string; more: string; findGame: string; coaches: string; clubs: string; tournaments: string; biggerText: string; updates?: string };

/** The bell's name from the unread count: "2 new updates", or "More than 9 new updates" past nine. */
export const updatesLabel = (t: (key: string, values?: Record<string, number>) => string, unread: number): string => (unread > 9 ? t("common.manyNewNotices") : t("common.newNotices", { count: unread }));

/**
 * The public doors every visitor gets, in the More menu: the open games to join (/play), the
 * coaches' directory, the clubs' page with the claim, the tournaments. They used to be reachable only
 * by URL or from a city page, which is how a club owner or a serious organiser arrived on kicksma.sh
 * and saw only the match form.
 */
const publicDoors = (labels: NavLabels): Door[] => [
  { key: "play", href: "/play", label: labels.findGame, kind: "public", testId: "nav-find" },
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
  // Unread notices are a bell with a number, and a link of their own to the inbox, named "2 new updates".
  // A bare "2" on "My matches" read as a count of matches (the owner, 12 October 2026: "the two
  // notifications in top signifies what? Already one upcoming match."). The bell is pinned to a corner
  // (absolute: no width on a phone): on "My matches" when that door is outside, else on the menu's ⋯,
  // where "My matches" waits. Never beside a role's door: there it took width, cut the word Kicksmash to
  // "Kic…" in Russian, and its number read as a count for "🎾 My assistant" (review, 12 October 2026).
  const count = roles.unread > 9 ? "9+" : String(roles.unread);
  const pinned = (el: React.ReactNode) =>
    roles.unread > 0 ? (
      <span className="relative inline-flex">
        {el}
        <InboxBell label={labels.updates || count} count={count} className="absolute -right-2 -top-2 inline-flex h-5 items-center gap-0.5 rounded-full bg-accent px-1.5 text-[11px] font-extrabold leading-none text-night ring-2 ring-bg" />
      </span>
    ) : (
      el
    );
  const playLink = (
    <Link key="play-link" href="/me" prefetch={false} className={chip} data-testid="nav-play">
      {labels.myMatches}
    </Link>
  );
  const play = pinned(playLink);
  // The menu is one short glyph, so the header keeps its one word beside it on a phone. Inside: the
  // way to My matches when this is not it, every role door not shown outside, then the public four,
  // then "Bigger text": the one setting a visitor may want before they have an account or a /me.
  const more = (inside: React.ReactNode[], bell: boolean) => {
    const menu = (
      <details className="relative">
        <summary className={`${chip} list-none cursor-pointer`} data-testid="nav-more" aria-label={labels.more} title={labels.more}>
          ⋯
        </summary>
        <div className="absolute right-0 z-20 mt-1 flex min-w-52 flex-col gap-1 rounded-xl border border-line bg-card p-2 shadow-lg">
          {inside}
          {inside.length > 0 && <div className="my-1 border-t border-line" />}
          {publicDoors(labels).map(link)}
          <div className="my-1 border-t border-line" />
          <TextSizeSwitch label={labels.biggerText} compact />
        </div>
      </details>
    );
    return bell ? pinned(menu) : menu;
  };

  // A player, and anyone we have never met: My matches, and the menu with the public doors.
  if (doors.length === 0)
    return (
      <>
        {play}
        {more([], false)}
      </>
    );

  // One other role: outside, whichever of the two this screen is not; the other one waits in the menu.
  // When "My matches" is not outside, its bell sits on the menu's corner, or nobody would see it.
  if (doors.length === 1) {
    const d = doors[0];
    const outside = current === d.kind ? play : link(d);
    const inside = current === d.kind ? [] : current === "play" ? [] : [playLink];
    return (
      <>
        {outside}
        {more(inside, current !== d.kind)}
      </>
    );
  }

  // Several roles: the menu alone, with every door in it, and the bell on its corner.
  return more([...(current !== "play" ? [playLink] : []), ...doors.map(link)], true);
}
