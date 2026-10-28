import { getLocale, getTranslations } from "next-intl/server";
import { cookies } from "next/headers";
import { getDb } from "@/db";
import type { Player } from "@/db/schema";
import { baseUrl, emailEnabled } from "@/lib/config";
import { isLevelVerified } from "@/lib/domain/levels";
import { playerHasPush } from "@/lib/domain/push";
import { personalPath, personalUrl } from "@/lib/personal";
import { vapidPublicKey } from "@/lib/pushConfig";
import { telegramBotId } from "@/lib/telegram/api";
import { EmailField } from "./EmailField";
import { HomeScreenPrompt } from "./HomeScreenPrompt";
import { LevelEditor } from "./LevelEditor";
import { NameEditor } from "./NameEditor";
import { PersonalLinkCard } from "./PersonalLinkCard";
import { PushToggle } from "./PushToggle";
import { RestoreWithEmail } from "./RestoreWithEmail";
import { SignOut } from "./SignOut";
import { TelegramLogin } from "./TelegramLogin";
import { markOf } from "@/lib/domain/emailMarks";
import { TEXT_SIZE_COOKIE, textSizeOf } from "@/lib/textSize";
import { nameOnly } from "@/actions/shared";
import { TextSizeSwitch } from "./TextSizeSwitch";
import { NoticeSettings } from "./NoticeSettings";
import { kindOn, NOTICE_KINDS, noticeSummary, type NoticeKind } from "@/lib/domain/noticeKinds";

/**
 * Everything a player sets rather than reads: reminders, the link that is their way back in, the
 * home-screen prompt, their name and level, bigger text, the Telegram link, and getting an account
 * back by email.
 *
 * It used to be the tail of MyMatches, which put it in the middle of the screen with the content
 * below it — "When do you want to play?" came after the delete button. Settings sit under the
 * content now, and the one irreversible button sits under them.
 */
/**
 * `personalToken` is null for a session that came in by "That's me" and has proved nothing since
 * (`nameOnlySession`, DECIDING rule 34): no personal link and no home-screen card for it. No reminders
 * either: every notification carries the personal link (`subscribePushAction` refuses such a session).
 *
 * `signOut`: "Not you? Sign out on this browser" under the name, on My matches only. The personal-link
 * page leaves it off: its address is itself the sign-in, so a sign-out there signed the browser straight
 * back in (`AdoptToken`).
 */
export async function MySettings({ player, personalToken, hasMatches, signOut = false }: { player: Player; personalToken: string | null; hasMatches: boolean; signOut?: boolean }) {
  const [t, locale, db, jar] = await Promise.all([getTranslations(), getLocale(), getDb(), cookies()]);
  // Two cookie reads; for a session by name, the reminders' read is not made at all.
  const pushHere = !(await nameOnly(player));
  const hasPush = pushHere ? await playerHasPush(db, player.id) : false;
  // Mail to this address stopped arriving: the one place the person can fix it is here, so it says so here.
  const mark = emailEnabled() && player.email ? await markOf(db, player.email) : null;
  const markedOn = mark ? new Intl.DateTimeFormat(locale, { day: "numeric", month: "long", timeZone: "UTC" }).format(mark.markedAt) : "";
  const settings = { kinds: player.noticeKinds, quietFrom: player.quietFrom, quietTo: player.quietTo, quietTz: player.quietTz };
  const sum = noticeSummary(settings);
  const summary = `${t("notices.summary", { on: sum.on, total: sum.total })} · ${sum.quiet ? t("notices.summaryQuiet", sum.quiet) : t("notices.summaryNoQuiet")}`;
  const on = Object.fromEntries(NOTICE_KINDS.map((k) => [k, kindOn(player.noticeKinds, k)])) as Record<NoticeKind, boolean>;
  return (
    <>
      {/* The toggle draws its own card: a phone that cannot do push sees no card, not an empty one. */}
      {pushHere && <PushToggle vapidPublicKey={vapidPublicKey()} subscribed={hasPush} card />}
      {/* What reaches this player and when: one line here, the switches behind it (the owner's decision D). */}
      <NoticeSettings on={on} quietFrom={player.quietFrom} quietTo={player.quietTo} summary={summary} />
      {personalToken && <PersonalLinkCard url={personalUrl(baseUrl(), personalToken)} email={player.email} emailEnabled={emailEnabled()} />}
      {personalToken && <HomeScreenPrompt personalPath={personalPath(personalToken)} installed={Boolean(player.homescreenAt)} />}
      <section className="card">
        <NameEditor name={player.displayName} />
        {/* Where the player sees their own name: "Not you? Sign out on this browser" (the owner, 28 October 2026). */}
        {signOut && <SignOut notYou={t("identity.notYou")} label={t("identity.signOut")} confirmText={t("identity.signOutConfirm")} testId="me-signout" />}
        <div className="mt-4 border-t border-line pt-4">
          <LevelEditor level={player.level} source={player.levelSource} log={player.levelLog} verified={isLevelVerified(player)} rankingOptIn={player.rankingOptIn} offerRanking={hasMatches} />
        </div>
        <div className="mt-4 border-t border-line pt-4">
          <TextSizeSwitch label={t("common.biggerText")} help={t("me.biggerTextHelp")} initial={textSizeOf(jar.get(TEXT_SIZE_COOKIE)?.value) === "big"} />
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
            {mark && (
              <p className="mb-3 rounded-xl bg-warn-soft px-3 py-2 text-sm font-semibold" data-testid="email-marked">
                {mark.kind === "complaint" ? t("me.emailComplained", { date: markedOn }) : t("me.emailBounced", { date: markedOn })}
              </p>
            )}
            <EmailField
              initial={player.email}
              mode="me"
              code=""
              title={t("event.yourEmail")}
              help={t("me.emailHelp")}
              emailEnabled
              notifyOn={player.emailNotifications}
              savedText={t("event.emailSavedNoMail")}
              saveLabel={t("me.saveEmail")}
            />
          </div>
        )}
        <p className="mt-3 text-xs text-faint" data-testid="identity-help">
          {personalToken ? t("me.identityHelp") : t("me.identityByName")}
        </p>
      </section>
      {/* For somebody with nothing yet, and for a session that came in by name: the code is how it proves itself. A player with matches already has their link above. */}
      {(!hasMatches || !personalToken) && emailEnabled() && (
        <section className="card">
          <RestoreWithEmail initialEmail={player.email ?? ""} />
        </section>
      )}
    </>
  );
}
