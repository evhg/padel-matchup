import type { Db } from "@/db";
import { APP_NAME, apexHost, baseUrl } from "@/lib/config";
import { readBooking } from "@/lib/domain/bookingPaste";
import { bookAnswer, mailBookingRead, mailShowsBooking, mailText, ownDomain, quotesOurAnswer } from "@/lib/domain/bookMail";
import { markedAmong } from "@/lib/domain/emailMarks";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { translatorFor } from "@/lib/email/templates";
import { addressKey } from "@/lib/ipKey";
import { guessLanguage } from "@/lib/listen/parse";
import { isAutomatedSender, parseAddress, sendPlainEmail, type InboundMail } from "@/lib/outreach/desk";
import { pasteBooking } from "./paste";

/**
 * book@<apex> (the owner, 11 October 2026: "New book@kicksma.sh"): a forwarded booking confirmation, or
 * a booking written in a mail, gets one answer from book@ with what was read and the filled match
 * form's link, and nothing else. It never makes a match, never holds a name, never sends a sign-in
 * link and never looks the sender up, because a sender's address can be faked: whoever opens the link
 * makes the match as themselves. It keeps nothing of the mail: no desk row, no body, no address in a
 * log line or a counter. claude@ stays the press desk, where nothing leaves without the owner's tap.
 *
 * Never answered: a robot (`machineMail`, or a sender such as mailer-daemon, postmaster or no-reply),
 * mail from our own domain (so book@ never answers itself), a mail that quotes our own answer
 * (`quotesOurAnswer`: a reply, or a robot that quotes, would loop), mail with no booking in it (no
 * platform's link, and no club with a day and a time), an address that bounced or complained
 * (`markedAmong`), a mail delivered twice (its Resend id, once a day), and mail over the limits:
 * `bookMailAnswersPerAddressPerDay` answers to one address (three: the address can be faked, so a
 * stranger gets three mails at most), the paste limit for each sender (`bookingPastesPerIpPerDay`), both
 * keyed on a hash of the address (`addressKey`), and `bookMailAnswersPerDay` answers a day for everybody
 * together. book@ opens no link of a mail (`preview: false`): a link in a forwarded confirmation can
 * carry a token or confirm, cancel or unsubscribe on the platform when it is opened (DECIDING rule 35).
 *
 * What it costs (AGENTS.md rule 12): a mail with no booking signal costs one counter write. A mail with
 * one costs three rate writes (the mail's id, the address's three, the day's cap), one read of the
 * address marks, what `pasteBooking` costs without a preview (one rate write and the clubs), one send
 * through Resend and two counters (`book_mail_answered`, `emails_sent`), at most
 * `bookMailAnswersPerDay` (thirty) times a day: Resend's free plan sends a hundred for the whole app.
 */
export const bookAddress = () => `book@${apexHost()}`;
const bookFrom = () => `${APP_NAME} <${bookAddress()}>`;

/** The mail is for our book@ (any of its recipients, the whole address: book@ at another domain is not ours). */
export const isBookMail = (to: readonly string[]): boolean => to.some((t) => parseAddress(t).email === bookAddress());

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

type SkipWhy = "sender" | "machine" | "own" | "quote" | "nothing" | "again" | "cap" | "marked" | "limit" | "send";
export type BookMailOutcome = "answered" | `skipped:${SkipWhy}`;

/** One mail to book@, read and answered or skipped. Never throws: a failure is a skip, counted. */
export async function answerBookMail(db: Db, mail: InboundMail, o: { fetchImpl?: typeof fetch; now?: Date } = {}): Promise<BookMailOutcome> {
  const now = o.now ?? new Date();
  const skip = async (why: SkipWhy): Promise<BookMailOutcome> => {
    await bumpMetric(db, "book_mail_skipped", 1, dayKey(now)).catch(() => undefined);
    return `skipped:${why}`;
  };
  const from = parseAddress(mail.from);
  if (!EMAIL_RE.test(from.email)) return skip("sender");
  if (mail.auto || isAutomatedSender(from.email)) return skip("machine");
  if (ownDomain(from.email, apexHost())) return skip("own");
  if (quotesOurAnswer(mail, `${baseUrl()}/?src=paste`)) return skip("quote");

  const { text, links, own } = mailText(mail.subject, mail.text, mail.html);
  // The shape first, with no read: a platform's link, or a day and a time.
  if (!mailShowsBooking(readBooking({ text, links, clubs: [], now, tz: "UTC" }))) return skip("nothing");
  if (!(await takeRate(db, "bookmail_id", mail.emailId, 1, "day", now))) return skip("again");
  // Three answers a day to one address, before the day's cap: a forged From cannot spend the thirty on one stranger.
  const to = addressKey(from.email);
  if (!(await takeRate(db, "bookmail_to", to, LIMITS.bookMailAnswersPerAddressPerDay, "day", now))) return skip("limit");
  const giveBackTo = () => takeRate(db, "bookmail_to", to, LIMITS.bookMailAnswersPerAddressPerDay, "day", now, -1).catch(() => undefined);
  if (!(await takeRate(db, "bookmail", "day", LIMITS.bookMailAnswersPerDay, "day", now))) {
    await giveBackTo();
    return skip("cap");
  }
  // An answer that does not go gives its places back: the address's and the day's cap.
  const giveBack = async () => {
    await takeRate(db, "bookmail", "day", LIMITS.bookMailAnswersPerDay, "day", now, -1).catch(() => undefined);
    await giveBackTo();
  };
  try {
    if ((await markedAmong(db, [from.email])).size) {
      await giveBack();
      return skip("marked");
    }
    // No player, no last venue, no account: the sender's address proves nobody. And no link is opened.
    const got = await pasteBooking(db, { text, links, tz: "UTC", rateKey: `mail:${to}`, playerId: null, selfName: from.name, now }, { fetchImpl: o.fetchImpl, preview: false });
    if (!got.ok || !mailBookingRead(got.read)) {
      await giveBack();
      return skip(!got.ok && got.reason === "limit" ? "limit" : "nothing");
    }
    // The sender's own words decide the language; the whole mail only when they wrote none.
    const locale = guessLanguage(/\p{L}/u.test(own) ? own : text);
    const { t } = await translatorFor(locale);
    const say = t as unknown as (key: string, values?: Record<string, string | number>) => string;
    const res = await sendPlainEmail(
      {
        to: from.email,
        subject: say("email.bookSubject"),
        text: bookAnswer(got.read, `${baseUrl()}${got.href}`, say, locale),
        inReplyTo: mail.messageId,
        from: bookFrom(),
        replyTo: bookAddress(),
        headers: { "Auto-Submitted": "auto-replied" },
      },
      o.fetchImpl,
    );
    if (!res.ok) {
      await giveBack();
      return skip("send");
    }
    // A sent answer is a sent email: the service board's Resend lines and the bounce rate count it.
    await bumpMetric(db, "book_mail_answered", 1, dayKey(now)).catch(() => undefined);
    await bumpMetric(db, "emails_sent", 1, dayKey(now)).catch(() => undefined);
    return "answered";
  } catch {
    await giveBack();
    return skip("send");
  }
}
