"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { myReachAction } from "@/actions/coach";
import { EmailField } from "@/components/EmailField";
import { PushToggle } from "@/components/PushToggle";

/**
 * "Where should I tell you about bookings?" — the one screen a coach cannot walk past.
 *
 * It replaced a step that offered Telegram alone and escaped through a button reading "Email me
 * instead" that collected no address. A coach who tapped it ended with no channel at all, and the
 * two lessons his student booked were never mentioned to him.
 *
 * What is required is a way to be reached, not a particular one: email stays optional for anybody who
 * picks Telegram or this phone. Only the channels this deployment actually runs are shown (rule 4),
 * and the push switch hides itself where the browser cannot do it, so the offer is never a dead end.
 *
 * Done asks the server rather than this screen. The email field and the push switch each save
 * themselves and neither reports back, so the only honest answer comes from the database.
 */
export function CoachNotify({
  botUsername,
  botUrl,
  email,
  emailEnabled,
  vapidPublicKey,
  pushSubscribed,
  gate = false,
  onReady,
}: {
  botUsername: string | null;
  /** The bot deep link carrying this coach's ticket, minted on the server so the button is live at once. */
  botUrl: string | null;
  email: string | null;
  emailEnabled: boolean;
  vapidPublicKey: string | null;
  pushSubscribed: boolean;
  /** On the book rather than in the walk: the coach is already set up and this is what stands in the way. */
  gate?: boolean;
  /** Where Done goes in the walk. Without it, Done reloads, which is what the book wants. */
  onReady?: () => void;
}) {
  const t = useTranslations("coach");
  const [pending, start] = useTransition();
  const [missing, setMissing] = useState(false);

  const done = () =>
    start(async () => {
      const r = await myReachAction();
      if (!r.ok || !r.data.any) {
        setMissing(true);
        return;
      }
      if (onReady) onReady();
      else window.location.assign("/coach");
    });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-xl font-extrabold tracking-tight">{t(gate ? "setup.notifyGateTitle" : "setup.notifyTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{gate ? t("setup.notifyGateHelp") : t("setup.notifyPick")}</p>
      </div>

      {botUsername && (
        <div className="rounded-xl border border-line p-3">
          <div className="text-sm font-bold">{t("setup.notifyTelegram")}</div>
          <p className="mt-1 text-sm text-muted">{t("setup.notifyHelp")}</p>
          <a href={botUrl ?? `https://t.me/${botUsername}`} target="_blank" rel="noopener noreferrer" className="btn-primary mt-3 w-full" data-testid="open-bot">
            {t("setup.botOpen", { bot: botUsername })}
          </a>
        </div>
      )}

      {emailEnabled && (
        <div className="rounded-xl border border-line p-3" data-testid="notify-email">
          <EmailField initial={email} mode="me" code="" title={t("setup.notifyEmailTitle")} help={t("setup.notifyEmailHelp")} emailEnabled savedText={t("setup.emailSaved")} showNotify={false} />
        </div>
      )}

      {vapidPublicKey && (
        <div className="rounded-xl border border-line p-3">
          {/* "This phone" read wrong on a desk, and the switch spoke of match reminders. A browser is a browser. */}
          <div className="text-sm font-bold">{t("setup.notifyPushTitle")}</div>
          <div className="mt-2">
            <PushToggle vapidPublicKey={vapidPublicKey} subscribed={pushSubscribed} compact labels={{ enable: t("setup.pushEnable"), on: t("setup.pushOn") }} />
          </div>
        </div>
      )}

      {missing && (
        <p className="text-sm font-semibold text-danger" data-testid="notify-none">
          {t("setup.notifyNone")}
        </p>
      )}
      <button type="button" className="btn-primary w-full" disabled={pending} onClick={done} data-testid="notify-done">
        {pending ? "…" : t("setup.notifyDone")}
      </button>
    </div>
  );
}
