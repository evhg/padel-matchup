import { getLocale, getTranslations } from "next-intl/server";
import { getDb } from "@/db";
import type { Player } from "@/db/schema";
import { baseUrl, emailEnabled } from "@/lib/config";
import { isLevelVerified } from "@/lib/domain/levels";
import { playerHasPush } from "@/lib/domain/push";
import { personalPath, personalUrl } from "@/lib/personal";
import { vapidPublicKey } from "@/lib/push";
import { telegramBotId } from "@/lib/telegram/api";
import { EmailField } from "./EmailField";
import { HomeScreenPrompt } from "./HomeScreenPrompt";
import { LevelEditor } from "./LevelEditor";
import { NameEditor } from "./NameEditor";
import { PersonalLinkCard } from "./PersonalLinkCard";
import { PushToggle } from "./PushToggle";
import { RestoreWithEmail } from "./RestoreWithEmail";
import { TelegramLogin } from "./TelegramLogin";

/**
 * Everything a player sets rather than reads: reminders, the link that is their way back in, the
 * home-screen prompt, their name and level, the Telegram link, and getting an account back by email.
 *
 * It used to be the tail of MyMatches, which put it in the middle of the screen with the content
 * below it — "When do you want to play?" came after the delete button. Settings sit under the
 * content now, and the one irreversible button sits under them.
 */
export async function MySettings({ player, personalToken, hasMatches }: { player: Player; personalToken: string; hasMatches: boolean }) {
  const [t, locale, db] = await Promise.all([getTranslations(), getLocale(), getDb()]);
  const hasPush = await playerHasPush(db, player.id);
  return (
    <>
      {/* The toggle draws its own card: a phone that cannot do push sees no card, not an empty one. */}
      <PushToggle vapidPublicKey={vapidPublicKey()} subscribed={hasPush} card />
      <PersonalLinkCard url={personalUrl(baseUrl(), personalToken)} email={player.email} emailEnabled={emailEnabled()} />
      <HomeScreenPrompt personalPath={personalPath(personalToken)} installed={Boolean(player.homescreenAt)} />
      <section className="card">
        <NameEditor name={player.displayName} />
        <div className="mt-4 border-t border-line pt-4">
          <LevelEditor level={player.level} source={player.levelSource} log={player.levelLog} verified={isLevelVerified(player)} rankingOptIn={player.rankingOptIn} offerRanking={hasMatches} />
        </div>
        {telegramBotId() && (
          <div className="mt-4 border-t border-line pt-4">
            <TelegramLogin botId={telegramBotId()!} linked={player.telegramId != null} linkedUsername={player.telegramUsername} lang={locale} authUrl={`${baseUrl()}/api/telegram/login`} />
          </div>
        )}
        {emailEnabled() && (
          /*
            The address was editable on a match page, on the share page and in the coach's walk, and
            nowhere on the screen called My matches — so "I can't change my email anywhere?" was a
            fair question and the answer was no. The field carries the match page's promises by
            default, and neither holds here: there is no match to put in a calendar.
          */
          <div className="mt-4 border-t border-line pt-4">
            <EmailField
              initial={player.email}
              mode="me"
              code=""
              title={t("event.yourEmail")}
              help={t("me.emailHelp")}
              emailEnabled
              notifyOn={player.emailNotifications}
              savedText={t("event.emailSavedNoMail")}
            />
          </div>
        )}
        <p className="mt-3 text-xs text-faint">{t("me.identityHelp")}</p>
      </section>
      {/* Only for somebody with nothing yet: a player with matches already has their link above. */}
      {!hasMatches && emailEnabled() && (
        <section className="card">
          <RestoreWithEmail initialEmail={player.email ?? ""} />
        </section>
      )}
    </>
  );
}
