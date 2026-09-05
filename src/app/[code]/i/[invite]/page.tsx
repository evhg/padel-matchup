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
import { getSlotByInviteCode } from "@/lib/domain/queries";
import { venueWithCourt } from "@/lib/labels";
import { getSessionPlayer } from "@/lib/session";

type Props = { params: Promise<{ code: string; invite: string }>; searchParams: Promise<{ decline?: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { invite } = await params;
  const t = await getTranslations();
  const db = await getDb();
  const found = isValidInviteCode(invite) ? await getSlotByInviteCode(db, invite) : null;
  return { title: found?.slot.invitedName ? t("invitePage.title", { name: found.slot.invitedName }) : t("event.match"), robots: { index: false } };
}

export default async function InvitePage({ params, searchParams }: Props) {
  const { code, invite } = await params;
  const { decline } = await searchParams;
  if (!isValidShareCode(code) || !isValidInviteCode(invite)) notFound();
  const db = await getDb();
  const found = await getSlotByInviteCode(db, invite);
  const [t, locale, me] = await Promise.all([getTranslations(), getLocale(), getSessionPlayer(db)]);

  const eventHref = `/${code}`;
  if (!found || found.event.code !== code) {
    return (
      <>
        <Header minimal />
        <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-6">
          <section className="card text-center">
            <h1 className="text-2xl font-extrabold">{t("invitePage.gone")}</h1>
            <p className="mt-2 text-muted">{t("invitePage.goneHelp")}</p>
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
  const courtNumber = (n: string) => t("event.courtNumber", { n });
  const venue = venueWithCourt(ev, { venueTbd: t("event.venueTbd"), courtNumber });
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
          <p className="mt-1 text-muted">{t("invitePage.subtitle", { organizer: creator.displayName })}</p>
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

        {knownOwner && slot.invitedEmail && (
          <section className="card border-court/30 bg-court-soft/30">
            <h2 className="font-extrabold">{t("invitePage.playedBefore", { email: slot.invitedEmail })}</h2>
            <p className="mt-0.5 mb-3 text-sm text-muted">{t("invitePage.playedBeforeHelp")}</p>
            <RestoreWithEmail initialEmail={slot.invitedEmail} compact />
          </section>
        )}
        <section className="card">
          {state === "invited" && <InviteActions code={code} inviteCode={invite} invitedName={name} hasIdentity={Boolean(me)} emailEnabled={emailEnabled()} knownEmail={me?.email ?? null} autoDecline={decline === "1"} reconfirm={false} />}
          {state === "declined" && (
            <>
              <h2 className="text-xl font-extrabold">{t("invitePage.declined")}</h2>
              <p className="mt-1 mb-4 text-sm text-muted">{t("invitePage.declinedHelp")}</p>
              <InviteActions code={code} inviteCode={invite} invitedName={name} hasIdentity={Boolean(me)} emailEnabled={emailEnabled()} knownEmail={me?.email ?? null} autoDecline={false} reconfirm />
            </>
          )}
          {state === "confirmed_mine" && (
            <>
              <h2 className="text-xl font-extrabold text-ok">✓ {t("invitePage.confirmed")}</h2>
              <p className="mt-1 text-sm text-muted">{t("invitePage.confirmedHelp")}</p>
              {me && <CalendarEmail code={code} email={me.email} emailEnabled={emailEnabled()} className="mt-4" />}
              <Link href={eventHref} className="btn-primary mt-2 w-full">
                {t("invitePage.goToEvent")}
              </Link>
            </>
          )}
          {state === "gone" && (
            <>
              <h2 className="text-xl font-extrabold">{t("invitePage.gone")}</h2>
              <p className="mt-1 text-sm text-muted">{t("invitePage.goneHelp")}</p>
              <Link href={eventHref} className="btn-primary mt-4 w-full">
                {t("invitePage.goToEvent")}
              </Link>
            </>
          )}
          {state === "cancelled" && (
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
