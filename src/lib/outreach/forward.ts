import { apexHost } from "@/lib/config";
import { deskFrom, parseAddress, type InboundMail } from "@/lib/outreach/desk";

/**
 * A copy of every mail that reaches an address at our domain, to the owner's own inbox (the owner, 25 November
 * 2026: "forward every email sent to @kicksma.sh to <the owner's address> for now"). The address lives in
 * MAIL_FORWARD_TO, never in this public repository. Off when it is not set.
 *
 * The copy is a new mail from the desk's sender with the original's sender, recipients, date and subject on top,
 * and its Reply-To is the original sender: a reply from the owner's inbox goes to that person, not to us. Two
 * guards against a loop: a forward address at our own domain is refused, and a mail from our own domain is
 * not forwarded. The original's attachments do not travel; the copy says how to find the mail in Resend.
 */
const ADDRESS = /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/;

/** The forward address, or null when it is not set, not an address, or at our own domain. */
export function forwardTarget(value: string | undefined = process.env.MAIL_FORWARD_TO, apex = apexHost()): string | null {
  const t = value?.trim();
  if (!t || !ADDRESS.test(t)) return null;
  return t.toLowerCase().endsWith(`@${apex.toLowerCase()}`) ? null : t;
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The forwarded mail: the subject, a plain text part and an HTML part, each with the original's facts on top. Pure. */
export function forwardBody(mail: InboundMail): { subject: string; text: string; html: string } {
  const date = (mail.receivedAt ?? new Date()).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const facts = [`From: ${mail.from}`, `To: ${mail.to.join(", ")}`, `Date: ${date}`, `Subject: ${mail.subject ?? "(no subject)"}`];
  const body = mail.text?.trim() || (mail.html ? mail.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "");
  const text = `---------- Forwarded by Kicksmash ----------\n${facts.join("\n")}\n\n${body}`;
  const top = `<div style="font:13px/1.5 sans-serif;color:#555;border-bottom:1px solid #ddd;padding-bottom:8px;margin-bottom:12px">Forwarded by Kicksmash<br>${facts.map(escape).join("<br>")}</div>`;
  const html = top + (mail.html ?? `<pre style="white-space:pre-wrap;font:14px/1.5 sans-serif">${escape(body)}</pre>`);
  return { subject: `Fwd: ${mail.subject ?? "(no subject)"}`, text, html };
}

export type ForwardOutcome = "off" | "own" | "sent" | "failed";

/** Send the copy. Never throws: a forward that fails must not stop the mail's own door. */
export async function forwardInbound(
  mail: InboundMail,
  fetchImpl: typeof fetch = fetch,
  env: { to?: string; key?: string } = { to: process.env.MAIL_FORWARD_TO, key: process.env.RESEND_API_KEY },
): Promise<ForwardOutcome> {
  const to = forwardTarget(env.to);
  if (!to || !env.key) return "off";
  const from = parseAddress(mail.from).email.toLowerCase();
  if (from.endsWith(`@${apexHost().toLowerCase()}`)) return "own";
  const { subject, text, html } = forwardBody(mail);
  try {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: deskFrom(), to: [to], reply_to: parseAddress(mail.from).email, subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
