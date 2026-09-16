import { getLocale, getTranslations } from "next-intl/server";
import { RestoreWithEmail } from "@/components/RestoreWithEmail";
import { TelegramLogin } from "@/components/TelegramLogin";
import { APP_NAME, baseUrl, emailEnabled } from "@/lib/config";
import { telegramBotId } from "@/lib/telegram/api";

/** Is there a way back in on this deployment at all? Neither channel set means no block to show (rule 4). */
export const canRestore = () => emailEnabled() || Boolean(telegramBotId());

/**
 * The way back to your own matches on a device that has never seen you: the email you gave, or the
 * Telegram account you signed in with. There is no password to remember, because there is no account.
 *
 * Two shapes, one body. On My matches, getting back in is what the page is for, so it stands open
 * under its own heading. On the landing page the subject is making a match, so it is one line a
 * returning player recognises and nobody else has to read — a `<details>`, which opens with no
 * JavaScript at all and takes nothing away from the name field above it.
 */
export async function ReturningPlayer({ collapsed = false }: { collapsed?: boolean }) {
  if (!canRestore()) return null;
  const [t, lang] = await Promise.all([getTranslations(), getLocale()]);
  const body = (
    <>
      <p className="mt-1 text-sm text-muted">{emailEnabled() ? t("me.returningHelp") : t("me.returningTelegramOnly")}</p>
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
  if (!collapsed)
    return (
      <>
        <h2 className="text-xl font-extrabold tracking-tight">{t("me.returningTitle")}</h2>
        {body}
      </>
    );
  return (
    <details className="mt-3 border-t border-line pt-3">
      <summary className="cursor-pointer list-none link text-sm font-semibold">{t("identity.usedBefore", { app: APP_NAME })}</summary>
      {body}
    </details>
  );
}
