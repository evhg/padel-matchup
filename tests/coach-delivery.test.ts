import { describe, expect, it } from "vitest";
import { channelFor } from "@/lib/coach/notify";

/**
 * Sixteen notices in the coach's book used to read `if (p.telegramId)` and nothing else, so a coach
 * who skipped the bot step and gave no address heard none of them — no error, no queue, no trace.
 * This is the order they fall through now, and the order is the whole point.
 */
describe("which channel a coach's notice takes", () => {
  const ALL = { telegram: true, email: true, push: true };
  const someone = { telegramId: 42, email: "a@b.co", emailNotifications: true };

  it("prefers Telegram, because that is where the buttons work", () => {
    expect(channelFor(someone, ALL)).toBe("telegram");
  });

  it("falls to email when the bot was never bound", () => {
    expect(channelFor({ ...someone, telegramId: null }, ALL)).toBe("email");
  });

  it("falls to push when there is no bot and no address — the case that used to be silence", () => {
    expect(channelFor({ telegramId: null, email: null, emailNotifications: true }, ALL)).toBe("push");
    expect(channelFor({ telegramId: null, email: "a@b.co", emailNotifications: false }, ALL)).toBe("push");
  });

  it("skips a channel the deployment has not configured, rather than dropping the notice", () => {
    expect(channelFor(someone, { ...ALL, telegram: false })).toBe("email");
    expect(channelFor(someone, { telegram: false, email: false, push: true })).toBe("push");
  });

  it("says so plainly when there is nowhere left to send", () => {
    expect(channelFor(someone, { telegram: false, email: false, push: false })).toBe("none");
    expect(channelFor(null, ALL)).toBe("none");
  });
});
