import { after, NextResponse } from "next/server";
import { getDb } from "@/db";
import { reportError } from "@/lib/alerts";
import { composeAck } from "@/lib/feedback/ack";
import { appendFeedbackReply, createFeedback, findNoteForReply, markAcknowledged, markNotFeedback } from "@/lib/feedback/store";
import { feedbackStrings } from "@/lib/feedback/strings";
import { guessLanguage } from "@/lib/listen/parse";
import { draftReplyTo, isAutomatedSender, notifyInbound, parseAddress, recordInbound, sendPlainEmail, type InboundMail } from "@/lib/outreach/desk";
import { verifySvix } from "@/lib/outreach/svix";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type ReceivedEvent = { type?: string; data?: { email_id?: string; from?: string; to?: string[]; subject?: string; message_id?: string } };
type ReceivedEmail = { id: string; from: string; to: string[]; subject: string | null; text: string | null; html: string | null; message_id?: string | null; headers?: Record<string, string> | { name: string; value: string }[]; created_at?: string };

/**
 * Resend's email.received webhook for claude@<apex>. Signed the Svix way with
 * RESEND_WEBHOOK_SECRET. The event carries metadata only; the body is fetched
 * from the Received Emails API. Everything in it is data from a stranger.
 */
export async function POST(req: Request) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: "not_configured" }, { status: 503 });
  const body = await req.text();
  const ok = verifySvix(secret, { id: req.headers.get("svix-id"), timestamp: req.headers.get("svix-timestamp"), signature: req.headers.get("svix-signature") }, body);
  if (!ok) return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  let event: ReceivedEvent;
  try {
    event = JSON.parse(body) as ReceivedEvent;
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }
  if (event.type !== "email.received" || !event.data?.email_id) return NextResponse.json({ ok: true, ignored: event.type ?? "unknown" });
  const emailId = event.data.email_id;
  const mail = await fetchReceived(emailId, event);
  if (!mail) return NextResponse.json({ error: "fetch_failed" }, { status: 502 });
  const db = await getDb();
  if (mail.to.some((t) => /^feedback@/i.test(parseAddress(t).email))) return feedbackByEmail(db, mail);
  const { row, fresh } = await recordInbound(db, mail);
  if (fresh) {
    const followUp = async () => {
      try {
        await notifyInbound(row);
        await draftReplyTo(db, row);
      } catch (e) {
        void reportError("server", e, { path: "/api/inbound/resend" });
      }
    };
    // After the response on Vercel; inline where there is no request scope (tests).
    try {
      after(followUp);
    } catch {
      await followUp();
    }
  }
  return NextResponse.json({ ok: true, id: row.id, fresh });
}

/** feedback@<apex>: a note for the loop, thanked at once; if something gets built from it, the word comes back in the same thread. */
async function feedbackByEmail(db: Awaited<ReturnType<typeof getDb>>, mail: InboundMail) {
  const from = parseAddress(mail.from);
  if (isAutomatedSender(from.email)) return NextResponse.json({ ok: true, ignored: "automated" });
  const bodyText = mail.text?.trim() || (mail.html ? mail.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
  const text = `${mail.subject ?? ""}\n\n${bodyText}`.trim();
  const locale = guessLanguage(text) ?? "en";
  // A reply to our thank-you (In-Reply-To set, or "Re:") joins the note it answers instead of opening a new one.
  const isReply = Boolean(mail.inReplyTo) || /^\s*(re|ответ|отв|aw|sv):/i.test(mail.subject ?? "");
  const earlier = isReply ? await findNoteForReply(db, { email: from.email }) : null;
  if (earlier) {
    const quoted = bodyText.split(/\n\s*(?:On .*wrote:|>\s|--\s*$|Claude, for Kicksmash|Claude, для Kicksmash|Claude, para Kicksmash)/)[0].trim();
    const updated = await appendFeedbackReply(db, earlier.id, quoted || bodyText);
    if (updated) {
      const fs = feedbackStrings(updated.locale);
      if (updated.messagesSent < 3) await sendPlainEmail({ to: from.email, subject: `Re: ${mail.subject ?? fs.emailSubject}`, text: `${fs.added}\n\nClaude, for Kicksmash\nhttps://kicksma.sh`, inReplyTo: mail.messageId }).catch(() => undefined);
      return NextResponse.json({ ok: true, id: updated.id, feedback: true, appended: true });
    }
  }
  const row = await createFeedback(db, { source: "email", text, locale, name: from.name, email: from.email, emailMessageId: mail.messageId ?? mail.emailId, context: "email" }).catch(() => null);
  if (!row) return NextResponse.json({ ok: true, ignored: "empty" });
  const fs = feedbackStrings(locale);
  const followUp = async () => {
    try {
      const ack = await composeAck(db, { text, name: from.name, locale, source: "email" });
      const body = `${ack.reply}\n\nClaude, for Kicksmash\nhttps://kicksma.sh`;
      const res = await sendPlainEmail({ to: from.email, subject: `Re: ${mail.subject ?? fs.emailSubject}`, text: body, inReplyTo: mail.messageId });
      if (ack.kind === "not_feedback") await markNotFeedback(db, row.id, ack.reply);
      else if (res.ok) await markAcknowledged(db, row.id, ack.reply);
    } catch (e) {
      void reportError("server", e, { path: "/api/inbound/resend" });
    }
  };
  try {
    after(followUp);
  } catch {
    await followUp();
  }
  return NextResponse.json({ ok: true, id: row.id, feedback: true });
}

async function fetchReceived(emailId: string, event: ReceivedEvent): Promise<InboundMail | null> {
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const m = (await res.json()) as ReceivedEmail;
    const headers = Array.isArray(m.headers) ? Object.fromEntries(m.headers.map((h) => [h.name.toLowerCase(), h.value])) : Object.fromEntries(Object.entries(m.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      emailId,
      from: m.from || event.data?.from || "unknown@unknown",
      to: m.to ?? event.data?.to ?? [],
      subject: m.subject ?? event.data?.subject ?? null,
      text: m.text,
      html: m.html,
      messageId: m.message_id ?? event.data?.message_id ?? headers["message-id"] ?? null,
      inReplyTo: headers["in-reply-to"] ?? null,
      receivedAt: m.created_at ? new Date(m.created_at) : undefined,
    };
  } catch {
    return null;
  }
}
