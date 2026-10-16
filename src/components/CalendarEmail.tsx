"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { resendCalendarInviteAction } from "@/actions/calendar";
import { proveMyEmail, updateMyEmail } from "@/actions/identity";
import { mailLine, type WelcomeKind } from "@/lib/domain/stayUpdated";
import { placeholderWidth } from "@/lib/fieldWidth";
import { EmailCodeStep } from "./EmailCodeStep";

/**
 * "Add to your calendar" = give us an email. The invite we send is a real
 * calendar invitation that updates itself on changes and cancellation,
 * unlike a copy created through a Google/Apple button. With an email on file
 * the invite already went out (on joining, or the moment the organizer created
 * the match), so a confirmation line is shown, with one quiet way to send it again.
 *
 * It says only what went, by the rule the "Stay updated" card asks (`mailLine`): the invitation and
 * "Send it again" only where `invited` (a seat, not a session by name) or the save answered `invite`;
 * the personal link's line on the waiting list; no mail line for a session by name (DECIDING rule 34).
 * Until 15 October 2026 it said "Calendar invite sent" after every save, and its "Send it again" then
 * failed for a session by name and on the waiting list (review).
 *
 * A session by name (`byName`) saves no address here until a 6-digit code proves it (the owner's
 * decision of 16 October 2026, D3): the form says a code goes first, and the code box stands in its place.
 */
export function CalendarEmail({
  code,
  email,
  emailEnabled,
  member = true,
  invited,
  byName = false,
  className = "",
}: {
  code: string;
  email: string | null;
  emailEnabled: boolean;
  /** A seat, not the waiting list: only a seat can ask for the invitation again (resendCalendarInviteAction). */
  member?: boolean;
  /** The address brings this player the match's invitation: a seat, mail on, and not a session by name. */
  invited: boolean;
  /** A session by name that proved nothing: the address waits for its code (D3). */
  byName?: boolean;
  className?: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  // The address a 6-digit code went to, while the form waits for the code (a session by name, D3).
  const [codeTo, setCodeTo] = useState<string | null>(null);
  const [value, setValue] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(email);
  // What the save here sent (`updateMyEmail`'s `welcome`); undefined until an address is typed here.
  const [welcome, setWelcome] = useState<WelcomeKind | null | undefined>(undefined);
  const [resent, setResent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!emailEnabled) return null;

  if (sentTo) {
    const said = mailLine({ sentTo, invited, welcome });
    if (said !== "invite") {
      return (
        <div className={`rounded-2xl bg-bg px-4 py-3 text-sm ${className}`} data-testid="calendar-email">
          <div className="font-semibold text-ok">{t("calendar.reached", { places: t("calendar.viaEmail") })}</div>
          {said === "link" && <div className="mt-1 text-muted">✉️ {t("calendar.linkSent")}</div>}
        </div>
      );
    }
    return (
      <div className={`rounded-2xl bg-bg px-4 py-3 text-sm ${className}`} data-testid="calendar-email">
        <div className="font-semibold text-ok">📅 {t("calendar.sentTo", { email: sentTo })}</div>
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
      </div>
    );
  }

  if (codeTo)
    return (
      <div className={`rounded-2xl border border-court/30 bg-court-soft/40 p-4 ${className}`} data-testid="calendar-email">
        <div className="mb-2 font-bold">🔔 {t("calendar.stayTitle")}</div>
        <EmailCodeStep
          email={codeTo}
          verifyLabel={t("identity.confirmCode")}
          onVerify={async (c) => {
            const r = await proveMyEmail(codeTo, c, code);
            if (r.ok) {
              setSentTo(r.data.email ?? codeTo);
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
    );

  return (
    <form
      className={`rounded-2xl border border-court/30 bg-court-soft/40 p-4 ${className}`}
      data-testid="calendar-email"
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        start(async () => {
          setError(null);
          const r = await updateMyEmail(value, code);
          if (r.ok && r.data.code === "sent") return setCodeTo(value.trim());
          if (!r.ok || !r.data.email) {
            setError(r.ok ? t("common.somethingWrong") : r.error === "too_many" ? t("identity.tooMany") : t("common.somethingWrong"));
            return;
          }
          setSentTo(r.data.email);
          setWelcome(r.data.welcome);
        });
      }}
    >
      {/* The calendar's promise only where an invitation goes; anybody else saves the address for the match's updates. */}
      <div className="font-bold">{invited ? `📅 ${t("calendar.emailTitle")}` : `🔔 ${t("calendar.stayTitle")}`}</div>
      <p className="mt-0.5 text-sm text-muted">{t(invited ? "calendar.emailHelp" : "calendar.emailHelpUpdates")}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <input type="email" inputMode="email" autoComplete="email" className="input flex-1" style={{ minWidth: placeholderWidth(t("share.emailPlaceholder")) }} placeholder={t("share.emailPlaceholder")} value={value} onChange={(e) => setValue(e.target.value)} required />
        <button type="submit" className="btn-primary shrink-0" disabled={pending || !value.trim()}>
          {pending ? t("common.working") : t(byName ? "identity.sendCode" : invited ? "calendar.send" : "common.save")}
        </button>
      </div>
      {byName && <p className="mt-1 text-xs text-muted">{t("calendar.codeFirst")}</p>}
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </form>
  );
}
