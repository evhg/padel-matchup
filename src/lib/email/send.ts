import "server-only";
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
};

/**
 * Fire-and-forget email. Never throws: when RESEND_API_KEY is missing the
 * whole email subsystem is silently disabled (decision: deploy never blocks on
 * email DNS), and delivery errors are logged, not surfaced to players.
 */
export async function sendEmail(msg: OutgoingEmail): Promise<boolean> {
  const r = resend();
  if (!r) return false;
  const from = emailFrom();
  try {
    const { error } = await r.emails.send({
      from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: msg.ics
        ? [
            {
              filename: msg.ics.method === "CANCEL" ? "cancel.ics" : "invite.ics",
              content: Buffer.from(msg.ics.content, "utf8").toString("base64"),
              contentType: `text/calendar; charset=utf-8; method=${msg.ics.method}`,
            },
          ]
        : undefined,
    });
    if (error) {
      console.error("[email] send failed", error);
      return false;
    }
    // Usage counter for /admin (best effort).
    try {
      const [{ getDb }, { bumpMetric }] = await Promise.all([import("@/db"), import("@/lib/domain/metrics")]);
      await bumpMetric(await getDb(), "emails_sent");
    } catch {
      /* metrics are optional */
    }
    return true;
  } catch (e) {
    console.error("[email] send threw", e);
    return false;
  }
}
