"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { resendCalendarInviteAction } from "@/actions/calendar";
import { proveMyEmail, updateMyEmail } from "@/actions/identity";
import { mailLine, type StayChannel, type StayState, type WelcomeKind } from "@/lib/domain/stayUpdated";
import { CalendarSubscribe } from "./CalendarSubscribe";
import { EmailCodeStep } from "./EmailCodeStep";
import { placeholderWidth } from "@/lib/fieldWidth";
import { readDeviceSignals } from "@/lib/deviceSignals";

type Props = {
  code: string;
  /** Seated, not waitlisted: only a seat can ask for the invitation again (resendCalendarInviteAction). */
  member: boolean;
  /**
   * The address on file brought this player the match's invitation: a seat, a deployment that sends mail,
   * and not a session by name (DECIDING rule 34). Only then does the card say an invitation went, or offer
   * it again, before anything is typed here.
   */
  invited: boolean;
  /**
   * A session by name that proved nothing (DECIDING rule 34): an address typed here is not saved until a
   * 6-digit code proves it (the owner's decision of 16 October 2026, D3), so the card says a code goes first.
   */
  byName?: boolean;
  /**
   * The player asked to join and waits for the organiser's answer (the owner's decision of 16 October 2026,
   * D5): the card asks for a channel for that answer, and promises no calendar invitation.
   */
  request?: boolean;
  email: string | null;
  state: Extract<StayState, { kind: "ask" | "reached" }>;
  /** One tap each into a chat the player already has; null where the deployment does not run it. */
  links: { whatsapp: string | null; telegram: string | null };
  /** The player's own feed, for a player whose calendar no email keeps up (src/lib/calendarFeed.ts). */
  feed: { webcal: string; google: string } | null;
};

/**
 * "Stay updated", where the calendar form used to be, the moment somebody joins. The owner's hurdle
 * was "oh no, not another app", so every choice is something the player already has: WhatsApp or
 * Telegram open with one tap and link this player there, and email is the calendar invitation it
 * always was. Once one is linked the card is one quiet line saying where updates go, and it never
 * asks again (src/lib/domain/stayUpdated.ts decides which of the two it is).
 *
 * A chat tap leaves the page, so when the person comes back the page asks the server again rather
 * than guessing: the card turns into the quiet line only once the bot has actually linked them.
 */
/** No store to follow: the snapshots alone say whether this render hydrates the page's own HTML (false) or mounts on a page already live (true). */
const noStore = () => () => undefined;

export function StayUpdated({ code, member, invited, byName = false, request = false, email, state, links, feed }: Props) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [value, setValue] = useState("");
  // What was typed here wins; otherwise the address the server knows, read on every render so a refresh that brings one is not missed.
  const [typed, setTyped] = useState<string | null>(null);
  const sentTo = typed ?? email;
  // What the save here sent (`updateMyEmail`'s `welcome`); undefined until an address is typed here.
  const [welcome, setWelcome] = useState<WelcomeKind | null | undefined>(undefined);
  // The card says only what went: after a save here, the save's own answer; before it, the page's (`mailLine`).
  const said = mailLine({ sentTo, invited, welcome });
  const [emailOpen, setEmailOpen] = useState(false);
  // The address a 6-digit code went to, while the card waits for the code (a session by name, D3).
  const [codeTo, setCodeTo] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<"whatsapp" | "telegram" | null>(null);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The card appears in the hero at the join, and the join's form sat lower: from the third seat on, and on
  // the waiting list, the page kept the form in view and the card was above the screen, wholly from the sixth
  // joiner of a night (review, 15 October 2026). So a card that mounts on a live page (the join, a sign-in)
  // comes into view when it is above it. A card that the page's own HTML holds hydrates and stays where the
  // reader is, so a reload never moves the page.
  const box = useRef<HTMLDivElement>(null);
  const live = useSyncExternalStore(noStore, () => true, () => false);
  const cameLive = useRef(live);
  useEffect(() => {
    if (cameLive.current && box.current && box.current.getBoundingClientRect().top < 0) box.current.scrollIntoView({ block: "start" });
  }, []);

  useEffect(() => {
    if (!waiting) return;
    const back = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    document.addEventListener("visibilitychange", back);
    return () => document.removeEventListener("visibilitychange", back);
  }, [waiting, router]);

  // An address typed here counts at once; the server's own answer follows with the refresh.
  const via: StayChannel[] = state.kind === "reached" ? state.via : [];
  const reached = via.length > 0 || Boolean(sentTo);
  const withEmail = sentTo && !via.includes("email") ? [...via, "email" as const] : via;

  if (reached) {
    // Every channel on the list carries the match's changes, a free spot and the result: WhatsApp as
    // templates Meta approved (src/lib/whatsapp/templates.ts), Telegram and email as they always did.
    const places = withEmail.map((c) => t(c === "whatsapp" ? "calendar.viaWhatsapp" : c === "telegram" ? "calendar.viaTelegram" : "calendar.viaEmail"));
    const line = t("calendar.reached", { places: new Intl.ListFormat(locale, { type: "conjunction" }).format(places) });
    // What the address brought, and nothing else: the invitation (and "Send it again" for a seat); on the
    // waiting list the personal link, whose invitation follows a place; for a session by name no line at
    // all, because it gets neither (DECIDING rule 34).
    const mail = said === "invite" && sentTo ? (
      <>
        <div className="mt-1 text-muted">📅 {t("calendar.sentTo", { email: sentTo })}</div>
        {member && (
          <div className="mt-1 text-muted">
            {resent ? (
              t("calendar.resent")
            ) : (
              <button
                type="button"
                className="underline disabled:opacity-60"
                disabled={pending}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const r = await resendCalendarInviteAction(code);
                    if (r.ok) setResent(true);
                    else setError(t("common.somethingWrong"));
                  })
                }
              >
                {pending ? t("common.working") : t("calendar.resend")}
              </button>
            )}
            {error && <span className="ml-2 font-semibold text-danger">{error}</span>}
          </div>
        )}
      </>
    ) : said === "link" ? (
      <div className="mt-1 text-muted">✉️ {t(request ? "calendar.linkSentRequest" : "calendar.linkSent")}</div>
    ) : null;
    return (
      <div ref={box} className="mt-4 scroll-mt-4 rounded-2xl bg-bg px-4 py-3 text-sm" data-testid="stay-updated">
        <div className="font-semibold text-ok">{line}</div>
        {sentTo ? mail : feed && <CalendarSubscribe webcal={feed.webcal} google={feed.google} chat={withEmail.includes("telegram")} />}
      </div>
    );
  }

  const choices = state.kind === "ask" ? state.choices : [];
  const chats = (["whatsapp", "telegram"] as const).filter((c) => choices.includes(c) && links[c]);
  const emailChoice = choices.includes("email");
  // Email alone needs no choosing: the form is the card.
  const showForm = emailChoice && (emailOpen || chats.length === 0);
  return (
    <div ref={box} className="mt-4 scroll-mt-4 rounded-2xl border border-court/30 bg-court-soft/40 p-4" data-testid="stay-updated">
      <div className="font-bold">🔔 {t("calendar.stayTitle")}</div>
      <p className="mt-0.5 text-sm text-muted">{t(request ? "calendar.stayHelpRequest" : "calendar.stayHelp")}</p>
      {chats.length > 0 && (
        <div className={`mt-3 grid gap-2 ${chats.length + (emailChoice ? 1 : 0) === 3 ? "grid-cols-3" : "grid-cols-2"}`}>
          {chats.map((c) => (
            <a key={c} href={links[c]!} target="_blank" rel="noopener noreferrer" className="btn-secondary btn-sm" data-testid={`stay-${c}`} onClick={() => setWaiting(c)}>
              {c === "whatsapp" ? "WhatsApp" : "Telegram"}
            </a>
          ))}
          {emailChoice && (
            // One primary action on the card: Send invite, once the form is open. The choice itself stays a choice.
            <button type="button" className="btn-secondary btn-sm" data-testid="stay-email" aria-expanded={emailOpen} onClick={() => setEmailOpen(true)}>
              {t("calendar.stayEmail")}
            </button>
          )}
        </div>
      )}
      {waiting && !showForm && <p className="mt-2 text-sm font-semibold">{t(waiting === "telegram" ? "calendar.stayTelegramNext" : "calendar.stayWhatsappNext")}</p>}
      {showForm && codeTo && (
        // The code that proves the address (D3): saved, and the session a full one, only once it comes back.
        <div className="mt-3">
          <EmailCodeStep
            email={codeTo}
            verifyLabel={t("identity.confirmCode")}
            onVerify={async (c) => {
              const r = await proveMyEmail(codeTo, c, code, { from: "stay", hint: readDeviceSignals() });
              if (r.ok) {
                setTyped(r.data.email ?? codeTo);
                setWelcome(r.data.welcome);
              }
              return r;
            }}
            onDone={() => {
              setCodeTo(null);
              router.refresh();
            }}
            onChangeEmail={() => setCodeTo(null)}
          />
        </div>
      )}
      {showForm && !codeTo && (
        <form
          className="mt-3 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            start(async () => {
              setError(null);
              // The card's own save: the one that answers "Stay updated" (`stay_linked_email`).
              const r = await updateMyEmail(value, code, { from: "stay" });
              if (r.ok && r.data.code === "sent") return setCodeTo(value.trim());
              if (!r.ok || !r.data.email) {
                setError(r.ok ? t("common.somethingWrong") : r.error === "too_many" ? t("identity.tooMany") : t("common.somethingWrong"));
                return;
              }
              setTyped(r.data.email);
              setWelcome(r.data.welcome);
            });
          }}
        >
          <input type="email" inputMode="email" autoComplete="email" className="input flex-1" style={{ minWidth: placeholderWidth(t("share.emailPlaceholder")) }} placeholder={t("share.emailPlaceholder")} value={value} onChange={(e) => setValue(e.target.value)} required />
          <button type="submit" className="btn-primary shrink-0" disabled={pending || !value.trim()}>
            {/* "Send invite" only where an invitation goes: a seat, never a session by name, which gets a code first. Anybody else saves the address. */}
            {pending ? t("common.working") : t(byName ? "identity.sendCode" : invited ? "calendar.send" : "common.save")}
          </button>
          {byName && <p className="w-full text-xs text-muted" data-testid="stay-code-first">{t("calendar.codeFirst")}</p>}
        </form>
      )}
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}
