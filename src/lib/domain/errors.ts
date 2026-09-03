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
  | "not_participant";

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
