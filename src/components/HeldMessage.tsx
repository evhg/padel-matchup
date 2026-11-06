import { getLocale, getTranslations } from "next-intl/server";
import { unreachedLine } from "@/lib/domain/unreached";
import { copiedValue } from "@/lib/share";
import { CopyButton, WhatsAppShare } from "./ShareSheet";

/**
 * "One message for Maria and Jordi" (DECIDING rule 34, the owner's decision A of 6 November 2026: "After
 * the hold, the page offers one message with the match link for all held players"). For the organiser,
 * under the line-up and on the share page after a new match, while a held place on the line-up can be
 * taken from the plain match link (`heldMessageOf`): each player opens the link and taps their own name.
 *
 * One quiet WhatsApp link, as the line of the players Kicksmash cannot reach has, so no second green
 * button stands beside the page's own Share (rule 3). It carries no phone, so WhatsApp's own picker lets
 * the organiser choose the group or several chats. "Copy this message" covers every other app. The text lists
 * every name, because each player must find theirs; the heading names five, then "N more".
 *
 * `others` are the held places the link cannot fill (a typed email or phone, two places of one name, a
 * record outside the limits with no door of its own): each keeps its personal link on its row. The share
 * page has no rows, so there (`where="share"`) the line says to open the match first. The help and that
 * line read as one person when one name is in them. The block's own Copy has a name of its own ("Copy this
 * message"), because "Send all invites in one message" on the same page has a "Copy message" that copies
 * other words.
 */
export async function HeldMessage({ where, url, text, names, others }: { where: "page" | "share"; url: string; text: string; names: string[]; others: string[] }) {
  const t = await getTranslations();
  const locale = await getLocale();
  const list = (all: readonly string[]) => {
    const { shown, more } = unreachedLine(all);
    return new Intl.ListFormat(locale, { type: "conjunction" }).format([...shown, ...(more ? [t("creator.unreachedMore", { count: more })] : [])]);
  };
  return (
    <div className="mt-3 rounded-2xl border border-line px-4 py-3" data-testid="held-message">
      <div className="text-sm font-bold">{t("creator.heldMessage", { names: list(names) })}</div>
      <p className="mt-0.5 text-xs text-muted">{t("creator.heldMessageHelp", { count: names.length })}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
        <WhatsAppShare url={url} text={text} testId="held-message-send" quiet />
        <CopyButton value={copiedValue(url, text, "message")} label={t("share.copyThisMessage")} className="btn-ghost btn-xs" />
      </div>
      {others.length > 0 && (
        <p className="mt-2 text-xs text-muted" data-testid="held-message-not">
          {t(where === "share" ? "creator.heldMessageNotShare" : "creator.heldMessageNot", { names: list(others), count: others.length })}
        </p>
      )}
    </div>
  );
}
