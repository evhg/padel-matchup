import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A day ticket: `subject_day_signature`. The subject as given, the day in
 * base 36, sixteen hex characters of an HMAC over subject, day and salt. Good
 * today and tomorrow, checked in constant time, and made only of
 * [A-Za-z0-9_-], so it fits where a Telegram start parameter (64 characters)
 * or a query string has to carry it. A salt binds the ticket to a state: when
 * the state changes, every ticket minted before it stops verifying.
 */
const DAY_MS = 86_400_000;
const sign = (secret: string, subject: string, bucket: number, salt: string) => createHmac("sha256", secret).update(`${subject}.${bucket}.${salt}`).digest("hex").slice(0, 16);

export function mintTicket(secret: string, subject: string, o: { salt?: string; now?: Date } = {}): string {
  const bucket = Math.floor((o.now ?? new Date()).getTime() / DAY_MS);
  return `${subject}_${bucket.toString(36)}_${sign(secret, subject, bucket, o.salt ?? "")}`;
}

/** The subject a ticket names, before it is checked (the check may need state that hangs off the subject). */
export function ticketSubject(ticket: string | null | undefined): string | null {
  const m = ticket ? /^([A-Za-z0-9-]{1,64})_([0-9a-z]{1,8})_([0-9a-f]{16})$/.exec(ticket) : null;
  return m ? m[1] : null;
}

/** The subject behind a ticket minted today or yesterday with this secret and salt, or null. */
export function readTicket(secret: string, ticket: string | null | undefined, o: { salt?: string; now?: Date } = {}): string | null {
  const m = ticket ? /^([A-Za-z0-9-]{1,64})_([0-9a-z]{1,8})_([0-9a-f]{16})$/.exec(ticket) : null;
  if (!m) return null;
  const [, subject, b, given] = m;
  const bucket = parseInt(b, 36);
  const current = Math.floor((o.now ?? new Date()).getTime() / DAY_MS);
  if (!Number.isInteger(bucket) || (bucket !== current && bucket !== current - 1)) return null;
  const want = sign(secret, subject, bucket, o.salt ?? "");
  return timingSafeEqual(Buffer.from(want), Buffer.from(given)) ? subject : null;
}
