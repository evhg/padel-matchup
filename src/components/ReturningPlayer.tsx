import { getLocale, getTranslations } from "next-intl/server";
import { BackInFold } from "@/components/BackInFold";
import { PasskeySignIn } from "@/components/PasskeySignIn";
import { RestoreWithEmail } from "@/components/RestoreWithEmail";
import { TelegramLogin } from "@/components/TelegramLogin";
import { APP_NAME, baseUrl, emailEnabled } from "@/lib/config";
import { telegramBotId } from "@/lib/telegram/api";

/**
 * Is there a way back in on this deployment that the server can promise? The email code or Telegram
 * (rule 4). Face ID or a fingerprint is always there besides (DECIDING rule 39), but only the browser
 * knows whether it can do it, so with neither channel set the block is the passkey button alone.
 */
export const canRestore = () => emailEnabled() || Boolean(telegramBotId());

/**
 * The way back to your own matches on a device that has never seen you: Face ID or a fingerprint on a
 * phone that remembers you (a passkey, DECIDING rule 39), the email you gave, or the Telegram account
 * you signed in with. There is no password to remember, because there is no account.
 *
 * Two shapes, one body. On My matches, getting back in is what the page is for, so it stands open
 * under its own heading. On the landing page the subject is making a match, so it is one line a
 * returning player recognises and nobody else has to read — a `<details>`, which opens with no
 * JavaScript at all and takes nothing away from the name field above it.
 */
/** `bare`: the doors alone, under a heading of the caller's own (the personal link of a place that keeps a record that can prove itself). */
export async function ReturningPlayer({ collapsed = false, bare = false }: { collapsed?: boolean; bare?: boolean }) {
  // Face ID or a fingerprint needs neither channel; the button stays away where the browser cannot do it.
  if (!canRestore()) return bare || !collapsed ? <PasskeySignIn /> : null;
  const [t, lang] = await Promise.all([getTranslations(), getLocale()]);
  const body = (
    <>
      <div className="mt-2">
        <PasskeySignIn />
      </div>
      <p className="mt-3 text-sm text-muted">{emailEnabled() ? t("me.returningHelp") : t("me.returningTelegramOnly")}</p>
      {emailEnabled() && (
        <div className="mt-3">
          <RestoreWithEmail compact />
        </div>
      )}
      {telegramBotId() && (
        <div className={emailEnabled() ? "mt-4 border-t border-line pt-3" : "mt-3"}>
          {emailEnabled() && <p className="mb-2 text-sm text-muted">{t("me.returningTelegram")}</p>}
          <TelegramLogin botId={telegramBotId()!} linked={false} linkedUsername={null} lang={lang} authUrl={`${baseUrl()}/api/telegram/login`} />
        </div>
      )}
    </>
  );
  if (bare) return body;
  if (!collapsed)
    return (
      <>
        <h2 className="text-xl font-extrabold tracking-tight">{t("me.returningTitle")}</h2>
        {body}
      </>
    );
  return <BackInFold summary={t("identity.usedBefore", { app: APP_NAME })}>{body}</BackInFold>;
}
