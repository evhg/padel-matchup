"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { resendCalendarInviteAction } from "@/actions/calendar";
import { updateMyEmail } from "@/actions/identity";
import type { StayChannel, StayState } from "@/lib/domain/stayUpdated";
import { CalendarSubscribe } from "./CalendarSubscribe";

type Props = {
  code: string;
  /** Seated, not waitlisted: only a seat can ask for the invitation again (resendCalendarInviteAction). */
  member: boolean;
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
export function StayUpdated({ code, member, email, state, links, feed }: Props) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [value, setValue] = useState("");
  // What was typed here wins; otherwise the address the server knows, read on every render so a refresh that brings one is not missed.
  const [typed, setTyped] = useState<string | null>(null);
  const sentTo = typed ?? email;
  const [emailOpen, setEmailOpen] = useState(false);
  const [waiting, setWaiting] = useState<"whatsapp" | "telegram" | null>(null);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

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
    return (
      <div className="mt-4 rounded-2xl bg-bg px-4 py-3 text-sm" data-testid="stay-updated">
        <div className="font-semibold text-ok">{line}</div>
        {sentTo ? (
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
        ) : (
          feed && <CalendarSubscribe webcal={feed.webcal} google={feed.google} chat={withEmail.includes("telegram")} />
        )}
      </div>
    );
  }

  const choices = state.kind === "ask" ? state.choices : [];
  const chats = (["whatsapp", "telegram"] as const).filter((c) => choices.includes(c) && links[c]);
  const emailChoice = choices.includes("email");
  // Email alone needs no choosing: the form is the card.
  const showForm = emailChoice && (emailOpen || chats.length === 0);
  return (
    <div className="mt-4 rounded-2xl border border-court/30 bg-court-soft/40 p-4" data-testid="stay-updated">
      <div className="font-bold">🔔 {t("calendar.stayTitle")}</div>
      <p className="mt-0.5 text-sm text-muted">{t("calendar.stayHelp")}</p>
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
      {showForm && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!value.trim()) return;
            start(async () => {
              setError(null);
              const r = await updateMyEmail(value, code);
              if (!r.ok || !r.data.email) {
                setError(t("common.somethingWrong"));
                return;
              }
              setTyped(r.data.email);
            });
          }}
        >
          <input type="email" inputMode="email" autoComplete="email" className="input" placeholder={t("share.emailPlaceholder")} value={value} onChange={(e) => setValue(e.target.value)} required />
          <button type="submit" className="btn-primary shrink-0" disabled={pending || !value.trim()}>
            {pending ? t("common.working") : t("calendar.send")}
          </button>
        </form>
      )}
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}
