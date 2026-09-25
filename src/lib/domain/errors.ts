export type DomainErrorCode =
  | "not_found"
  | "cancelled"
  | "past"
  | "full"
  | "closed"
  | "already_in"
  | "not_member"
  | "forbidden"
  | "invalid"
  | "locked"
  | "not_started"
  | "not_participant"
  | "slot_taken"
  | "not_student"
  // The coach blocked this person. No booking, no asking, and an invite link does not let them in.
  | "blocked"
  // The coach takes anybody, but answers a first booking themselves. The caller makes a request.
  | "needs_approval"
  // Nobody would hear it: the coach has no Telegram, no email, no push device and no WhatsApp yet,
  // so a newcomer's booking or ask would sit in a book nobody reads (the owner, 25 September 2026).
  | "not_taking_bookings"
  | "outside_hours"
  | "too_soon"
  // A student moving a lesson that is already inside the coach's cutoff: at that point it is a
  // cancellation under the usual policy, or the late-cancel rule would mean nothing.
  | "too_late"
  // Closing a coach's book while a lesson is still to come: the student is waiting for that hour, so
  // it is cancelled through the path that tells them, and only then is the book closed.
  | "has_lessons" | "already_paid"
  // A student taking a package from the coach's page while they still hold one with lessons left.
  | "has_package"
  | "no_coach"
  // More standing wants than one player may hold: past ten it is not a want, it is a subscription
  // to everything happening at that club.
  | "too_many";

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}

export const isDomainError = (e: unknown): e is DomainError => e instanceof DomainError;
