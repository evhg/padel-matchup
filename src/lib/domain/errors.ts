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
  | "outside_hours"
  | "too_soon"
  // A student moving a lesson that is already inside the coach's cutoff: at that point it is a
  // cancellation under the usual policy, or the late-cancel rule would mean nothing.
  | "too_late"
  | "no_coach";

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
