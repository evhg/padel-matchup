import { describe, expect, it } from "vitest";
import { SCORE_REMINDER_DELAY_MS, SECOND_SCORE_REMINDER_DELAY_MS } from "@/lib/config";
import { isScoreReminderDue, isSecondScoreReminderDue } from "@/lib/domain/reminders";

/**
 * A match with no score moves nobody's level, enters no ranking and records no podium. One ask two
 * hours after the start is a single roll of the dice: it lands while people are still at the club,
 * or it never lands. These are the rules for asking exactly once more.
 */
describe("the second ask for a missing score", () => {
  // A fixed instant, never today (rule 11).
  const start = new Date("2026-09-14T10:00:00.000Z");
  const after = (ms: number) => new Date(start.getTime() + ms);
  const ev = (over: Partial<Parameters<typeof isSecondScoreReminderDue>[0]> = {}) => ({
    status: "past" as const,
    startsAt: start,
    scoreReminderSent: true,
    scoreReminder2At: null,
    standings: null,
    type: "match" as const,
    ...over,
  });

  it("waits for the first ask to have gone out", () => {
    expect(isSecondScoreReminderDue(ev({ scoreReminderSent: false }), false, after(SECOND_SCORE_REMINDER_DELAY_MS))).toBe(false);
    expect(isSecondScoreReminderDue(ev(), false, after(SECOND_SCORE_REMINDER_DELAY_MS))).toBe(true);
  });

  it("waits the full delay, which is long enough to be the next morning and not the same evening", () => {
    expect(SECOND_SCORE_REMINDER_DELAY_MS).toBeGreaterThan(SCORE_REMINDER_DELAY_MS);
    expect(isSecondScoreReminderDue(ev(), false, after(SECOND_SCORE_REMINDER_DELAY_MS - 1))).toBe(false);
    expect(isSecondScoreReminderDue(ev(), false, after(SECOND_SCORE_REMINDER_DELAY_MS))).toBe(true);
  });

  it("asks exactly once more and then never again", () => {
    const asked = ev({ scoreReminder2At: after(SECOND_SCORE_REMINDER_DELAY_MS) });
    expect(isSecondScoreReminderDue(asked, false, after(SECOND_SCORE_REMINDER_DELAY_MS * 5))).toBe(false);
  });

  it("stops the moment a score arrives, and never chases a cancelled match or a finalised tournament", () => {
    const late = after(SECOND_SCORE_REMINDER_DELAY_MS);
    expect(isSecondScoreReminderDue(ev(), true, late)).toBe(false);
    expect(isSecondScoreReminderDue(ev({ status: "cancelled" }), false, late)).toBe(false);
    expect(isSecondScoreReminderDue(ev({ type: "tournament", standings: [{ playerId: "p", points: 1 }] as never }), false, late)).toBe(false);
  });

  it("leaves the first ask exactly as it was", () => {
    const fresh = { status: "past" as const, startsAt: start, scoreReminderSent: false, standings: null, type: "match" as const };
    expect(isScoreReminderDue(fresh, false, after(SCORE_REMINDER_DELAY_MS))).toBe(true);
    expect(isScoreReminderDue({ ...fresh, scoreReminderSent: true }, false, after(SCORE_REMINDER_DELAY_MS))).toBe(false);
  });
});
