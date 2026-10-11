import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { CalendarEmail } from "@/components/CalendarEmail";
import { Header } from "@/components/Header";
import { InviteActions } from "@/components/InviteActions";
import { RestoreWithEmail } from "@/components/RestoreWithEmail";
import { getDb } from "@/db";
import { calendarTitle } from "@/lib/calendar";
import { isValidInviteCode, isValidShareCode } from "@/lib/codes";
import { emailEnabled } from "@/lib/config";
import { formatEventDayLong, formatEventTime, tzLabel } from "@/lib/dates";
import { playersWithEmail } from "@/lib/domain/identity";
import { inviteView } from "@/lib/domain/heldByName";
import { getSlotByInviteCode, holdsPlaceIn } from "@/lib/domain/queries";
import { namedByOf } from "@/lib/domain/pairSeats";
import { mayUseHeldLink } from "@/lib/domain/slots";
import { venueWithCourt } from "@/lib/labels";
import { getSessionPlayer } from "@/lib/session";
import { withClientMessages } from "@/i18n/withClientMessages";

type Props = { params: Promise<{ code: string; invite: string }>; searchParams: Promise<{ decline?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { invite } = await params;
  const t = await getTranslations();
  const db = await getDb();
  const found = isValidInviteCode(invite) ? await getSlotByInviteCode(db, invite) : null;
  return { title: found?.slot.invitedName ? t("invitePage.title", { name: found.slot.invitedName }) : t("event.match"), robots: { index: false } };
}

async function InvitePage({ params, searchParams }: Props) {
  const { code, invite } = await params;
  const { decline } = await searchParams;
  if (!isValidShareCode(code) || !isValidInviteCode(invite)) notFound();
  const db = await getDb();
  const found = await getSlotByInviteCode(db, invite);
  const [t, locale, me] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db)]);

  const eventHref = `/${code}`;
  if (!found || found.event.code !== code) {
    // A link whose place was released while its person was in by another door: they are in, so the
    // page says so rather than "no longer valid". One read, only for a browser that knows somebody.
    const inAlready = me ? await holdsPlaceIn(db, code, me.id) : false;
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-6">
          <section className="card text-center">
            <h1 className="text-2xl font-extrabold">{inAlready ? t("invitePage.alreadyIn") : t("invitePage.gone")}</h1>
            {!inAlready && <p className="mt-2 text-muted">{t("invitePage.goneHelp")}</p>}
            <Link href={eventHref} className="btn-primary mt-5 w-full">
              {t("invitePage.goToEvent")}
            </Link>
          </section>
        </main>
      </>
    );
  }

  const { slot, event: ev, creator } = found;
  const name = slot.invitedName ?? "";
  const title = calendarTitle(ev, t(ev.type === "match" ? "event.match" : "event.tournament"));
  const mine = Boolean(me && slot.playerId === me.id);
  const state: "invited" | "declined" | "confirmed_mine" | "gone" | "cancelled" =
    ev.status === "cancelled" ? "cancelled" : slot.status === "invited" ? "invited" : slot.status === "declined" ? "declined" : (slot.status === "confirmed" || slot.status === "joined") && mine ? "confirmed_mine" : "gone";
  // Somebody whose record is in this match already (the organiser checking the link, a player who
  // opened a friend's): "I'm in" would only free this place, so the page asks the server's own rule
  // (`mayUseHeldLink`). The person it is held for, in by another door, keeps "I'm in": it frees the
  // place for the waiting list, and on a fixed-pairs night it makes the pair. Anybody else reads whose
  // place it is, or that it is open again (`inviteView`). One read, only for a browser that knows somebody.
  const notMine = state === "invited" || state === "declined" || state === "gone";
  const inAlready = me && notMine ? await holdsPlaceIn(db, code, me.id) : false;
  const theirs = me && inAlready && (state === "invited" || state === "declined") ? await mayUseHeldLink(db, ev, slot, me) : true;
  const view = inviteView(state, Boolean(inAlready), theirs);
  const courtNumber = (n: string) => t("event.courtNumber", { n });
  const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber });
  // A fixed-pairs night: the player who named them, not the organiser, saved this spot; and a pair can
  // wait together on the waiting list, where a claimed spot is not yet a place on court.
  const namedBy = ev.fixedPairs ? await namedByOf(db, slot) : null;
  const waitingAt = slot.position > ev.capacity ? slot.position - ev.capacity : 0;
  // The organizer typed an email we already know from another identity: offer to restore it (with a code) before confirming.
  const knownOwner =
    (state === "invited" || state === "declined") && emailEnabled() && slot.invitedEmail && !me?.email
      ? (await playersWithEmail(db, slot.invitedEmail)).some((p) => p.id !== me?.id)
      : false;

  return (
    <>
      <Header minimal />
      <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-4 pb-12">
        <section className="card">
          <div className="text-xs font-extrabold uppercase tracking-wider text-faint">{t(ev.type === "match" ? "event.match" : "event.tournament")}</div>
          <h1 className="mt-1 text-3xl font-extrabold tracking-tight">{state === "invited" || state === "declined" ? t("invitePage.title", { name }) : title}</h1>
          <p className="mt-1 text-muted">{namedBy ? t("pairs.invitedBy", { partner: namedBy }) : t("invitePage.subtitle", { organizer: creator.displayName })}</p>
          {waitingAt > 0 && state === "invited" && <p className="mt-1 text-sm font-semibold text-warn">{t("pairs.inviteWaiting")}</p>}
          <div className="mt-4 flex items-end gap-3">
            <div className="text-5xl font-extrabold tracking-tighter tabular-nums">{formatEventTime(ev.startsAt, ev.tz, locale)}</div>
            <div className="pb-1">
              <div className="text-lg font-bold leading-tight">{formatEventDayLong(ev.startsAt, ev.tz, locale)}</div>
              <div className="text-xs font-semibold text-faint">{tzLabel(ev.startsAt, ev.tz, locale)}</div>
            </div>
          </div>
          <div className={`mt-3 rounded-2xl bg-bg px-4 py-3 font-bold ${ev.venueName ? "" : "text-muted"}`}>
            {venue}
            {ev.venueMapUrl && (
              <a href={ev.venueMapUrl} target="_blank" rel="noopener noreferrer" className="ml-2 text-sm link">
                📍 {t("event.openMap")}
              </a>
            )}
          </div>
          {ev.title && <div className="mt-2 text-sm text-muted">{ev.title}</div>}
          {ev.note && <p className="mt-2 whitespace-pre-line text-sm text-ink-soft">{ev.note}</p>}
        </section>

        {knownOwner && (view === "actions" || view === "declined") && slot.invitedEmail && (
          <section className="card border-court/30 bg-court-soft/30">
            <h2 className="font-extrabold">{t("invitePage.playedBefore", { email: slot.invitedEmail })}</h2>
            <p className="mt-0.5 mb-3 text-sm text-muted">{t("invitePage.playedBeforeHelp")}</p>
            <RestoreWithEmail initialEmail={slot.invitedEmail} compact />
          </section>
        )}
        <section className="card">
          {view === "held_for" && (
            <>
              <h2 className="text-xl font-extrabold">{t("invitePage.heldFor", { name })}</h2>
              <p className="mt-1 text-sm text-muted">{t("invitePage.heldForHelp", { name })}</p>
              <Link href={eventHref} className="btn-primary mt-4 w-full">
                {t("invitePage.goToEvent")}
              </Link>
            </>
          )}
          {view === "open_again" && (
            <>
              <h2 className="text-xl font-extrabold">{t("event.declinedOpen", { name })}</h2>
              <Link href={eventHref} className="btn-primary mt-4 w-full">
                {t("invitePage.goToEvent")}
              </Link>
            </>
          )}
          {view === "actions" && <InviteActions code={code} inviteCode={invite} invitedName={name} hasIdentity={Boolean(me)} emailEnabled={emailEnabled()} knownEmail={me?.email ?? null} autoDecline={decline === "1"} reconfirm={false} />}
          {view === "declined" && (
            <>
              <h2 className="text-xl font-extrabold">{t("invitePage.declined")}</h2>
              <p className="mt-1 mb-4 text-sm text-muted">{t("invitePage.declinedHelp")}</p>
              <InviteActions code={code} inviteCode={invite} invitedName={name} hasIdentity={Boolean(me)} emailEnabled={emailEnabled()} knownEmail={me?.email ?? null} autoDecline={false} reconfirm />
            </>
          )}
          {view === "confirmed" && (
            <>
              <h2 className={`text-xl font-extrabold ${waitingAt ? "" : "text-ok"}`}>{waitingAt ? t("event.youAreOnWaitlist", { position: waitingAt }) : `✓ ${t("invitePage.confirmed")}`}</h2>
              <p className="mt-1 text-sm text-muted">{waitingAt ? t("pairs.inviteWaiting") : t("invitePage.confirmedHelp")}</p>
              {me && <CalendarEmail code={code} email={me.email} emailEnabled={emailEnabled()} className="mt-4" />}
              <Link href={eventHref} className="btn-primary mt-2 w-full">
                {t("invitePage.goToEvent")}
              </Link>
            </>
          )}
          {(view === "gone" || view === "already_in") && (
            <>
              <h2 className="text-xl font-extrabold">{view === "already_in" ? t("invitePage.alreadyIn") : t("invitePage.gone")}</h2>
              {view === "gone" && <p className="mt-1 text-sm text-muted">{t("invitePage.goneHelp")}</p>}
              <Link href={eventHref} className="btn-primary mt-4 w-full">
                {t("invitePage.goToEvent")}
              </Link>
            </>
          )}
          {view === "cancelled" && (
            <>
              <h2 className="text-xl font-extrabold text-danger">{t("event.cancelled")}</h2>
              <p className="mt-1 text-sm text-muted">{t("event.cancelledHelp")}</p>
              <Link href={eventHref} className="btn-ghost mt-4 w-full">
                {t("invitePage.goToEvent")}
              </Link>
            </>
          )}
        </section>
      </main>
    </>
  );
}

export default withClientMessages(["calendar", "common", "creator", "errors", "event", "identity", "invitePage", "share"], InvitePage);
