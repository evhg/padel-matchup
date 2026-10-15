import "server-only";
import { onVercel } from "@/lib/env";
import { Resend } from "resend";
import { emailEnabled, emailFrom } from "@/lib/config";

let client: Resend | null = null;

function resend(): Resend | null {
  if (!emailEnabled()) return null;
  if (!client) client = new Resend(process.env.RESEND_API_KEY);
  return client;
}

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  ics?: { content: string; method: "REQUEST" | "CANCEL" };
  /** Any other file: the month's statement, for one. UTF-8 text, base64-encoded here. */
  files?: { filename: string; content: string; contentType: string }[];
  /**
   * A code the person asked for. It goes even to a marked address, because a code arriving is the
   * only proof that a marked address works again (`clearMark` when it is typed back).
   */
  proof?: boolean;
};

/**
 * Fire-and-forget email. Never throws: when RESEND_API_KEY is missing the
 * whole email subsystem is silently disabled (decision: deploy never blocks on
 * email DNS), and delivery errors are logged, not surfaced to players.
 */
let warnedSink = false;

export async function sendEmail(msg: OutgoingEmail): Promise<boolean> {
  const r = resend();
  if (!r) return false;
  // An address that bounced hard, complained, or kept bouncing is not written to again until a code
  // proves it works (src/lib/domain/emailMarks.ts). Resend would refuse it anyway; asking first
  // keeps the attempt out of the sender's reputation and lets the caller use another channel.
  try {
    const [{ getDb }, { markedAmong }] = await Promise.all([import("@/db"), import("@/lib/domain/emailMarks")]);
    if (!msg.proof && (await markedAmong(await getDb(), [msg.to])).size) return false;
  } catch {
    /* a check that cannot run must not stop the mail */
  }
  // A file sink for local and CI runs only: on Vercel a stray variable must not swallow real mail, and the log says it was ignored.
  if (process.env.EMAIL_SINK_FILE) {
    if (!onVercel()) return sink(msg);
    if (!warnedSink) {
      warnedSink = true;
      console.warn("[email] EMAIL_SINK_FILE is set but ignored on Vercel; mail goes out for real");
    }
  }
  const from = emailFrom();
  try {
    const { error } = await r.emails.send({
      from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.ics || msg.files?.length
        ? [
            ...(msg.ics
              ? [
                  {
                    filename: msg.ics.method === "CANCEL" ? "cancel.ics" : "invite.ics",
                    content: Buffer.from(msg.ics.content, "utf8").toString("base64"),
                    contentType: `text/calendar; charset=utf-8; method=${msg.ics.method}`,
                  },
                ]
              : []),
            ...(msg.files ?? []).map((f) => ({ filename: f.filename, content: Buffer.from(f.content, "utf8").toString("base64"), contentType: f.contentType })),
          ]
        : undefined,
    });
    if (error) {
      console.error("[email] send failed", error);
      await count("emails_failed");
      return false;
    }
    await count("emails_sent");
    return true;
  } catch (e) {
    console.error("[email] send threw", e);
    await count("emails_failed");
    return false;
  }
}

/**
 * Usage counters for /admin and the service board (best effort). A failure is counted too: on 23
 * September a player asked why nobody got the match's email, and the log line was the only trace, so
 * the board said "30 sent" and nothing else. Resend's rows now say "N failed today".
 */
async function count(key: "emails_sent" | "emails_failed"): Promise<void> {
  try {
    const [{ getDb }, { bumpMetric }] = await Promise.all([import("@/db"), import("@/lib/domain/metrics")]);
    await bumpMetric(await getDb(), key);
  } catch {
    /* metrics are optional */
  }
}

/** Test servers set EMAIL_SINK_FILE: every message lands there as one JSON line and nothing is sent. */
async function sink(msg: OutgoingEmail): Promise<boolean> {
  try {
    const { appendFile } = await import("node:fs/promises");
    const line = { at: new Date().toISOString(), to: msg.to, subject: msg.subject, text: msg.text, ics: msg.ics ?? null };
    await appendFile(process.env.EMAIL_SINK_FILE!, JSON.stringify(line) + "\n");
    return true;
  } catch (e) {
    console.error("[email] sink failed", e);
    return false;
  }
}
