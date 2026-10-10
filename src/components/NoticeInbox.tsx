import { getLocale, getTranslations } from "next-intl/server";
import type { Db } from "@/db";
import { relativeTime } from "@/lib/dates";
import { inboxOf } from "@/lib/domain/notices";
import { INBOX_DAYS } from "@/lib/domain/noticeKinds";
import { noticeText } from "@/lib/noticeText";
import { InboxDetails } from "./InboxDetails";

/**
 * The inbox on My matches (the owner's decision D): every notice the app sent this player, or kept
 * for them while a kind was off or quiet hours held it, newest first. Nothing at all until the first
 * notice exists (`docs/DECIDING.md` rule 3), then one line, "Inbox · 2 new", that opens to the list
 * and reads it. Each line is written in the reader's language from the row's key and facts, and opens
 * its match's public page, never a personal link.
 */
export async function NoticeInbox({ db, playerId }: { db: Db; playerId: string }) {
  const { rows, unread } = await inboxOf(db, playerId);
  if (rows.length === 0) return null;
  const [t, locale] = await Promise.all([getTranslations(), getLocale()]);
  const say = t as unknown as (key: string, values?: Record<string, string | number>) => string;
  const items = rows.map((r) => ({ id: r.id, text: noticeText(say, locale, r), when: relativeTime(r.createdAt, locale), unread: r.readAt === null, href: r.code ? `/${r.code}` : null }));
  return <InboxDetails title={t("notices.inboxTitle")} newLabel={unread > 0 ? t("notices.inboxNew", { count: unread > 9 ? "9+" : unread }) : null} unreadLabel={t("notices.unread")} help={t("notices.inboxHelp", { days: INBOX_DAYS })} items={items} />;
}
