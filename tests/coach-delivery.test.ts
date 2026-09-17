import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { channelFor, lessonIcs } from "@/lib/coach/notify";
import { reachFor } from "@/lib/coach/reach";
import { savePushSubscription } from "@/lib/domain/push";
import { updatePlayer } from "@/lib/domain/players";
import { createTestDb, makePlayer } from "./helpers/db";

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

/**
 * The gate on the book asks a different question from `channelFor`: not "which channel should this
 * notice take" but "is there one at all". `channelFor` answers "push" whenever push is configured,
 * which is right for a notice that may fail quietly and wrong for a gate, so this one goes to the
 * database and asks whether a device is really registered.
 */
describe("whether the assistant can reach a coach at all", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.RESEND_API_KEY = "r";
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
  });
  afterAll(async () => close());

  it("says no to somebody with no bot, no address and no device — the state Ricardo's book was in", async () => {
    const p = await makePlayer(db, "Quiet");
    expect(await reachFor(db, p)).toMatchObject({ telegram: false, email: false, push: false, any: false });
  });

  it("counts an address, a bound bot, or a registered device, one at a time", async () => {
    const byEmail = await makePlayer(db, "Mailed");
    await updatePlayer(db, byEmail.id, { email: "coach@example.com" });
    expect((await reachFor(db, { ...byEmail, email: "coach@example.com" })).any).toBe(true);

    const byBot = await makePlayer(db, "Bound");
    expect((await reachFor(db, { ...byBot, telegramId: 99 })).any).toBe(true);

    const byPhone = await makePlayer(db, "Phone");
    await savePushSubscription(db, byPhone.id, { endpoint: "https://push.example/1", keys: { p256dh: "k", auth: "a" } });
    expect(await reachFor(db, byPhone)).toMatchObject({ push: true, any: true });
  });

  it("does not count a channel this deployment has not configured (rule 4)", async () => {
    const p = await makePlayer(db, "Everywhere");
    await savePushSubscription(db, p.id, { endpoint: "https://push.example/2", keys: { p256dh: "k", auth: "a" } });
    const all = { ...p, telegramId: 7, email: "a@b.co" };
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.RESEND_API_KEY;
    delete process.env.VAPID_PUBLIC_KEY;
    try {
      expect(await reachFor(db, all)).toMatchObject({ telegram: false, email: false, push: false, any: false });
    } finally {
      process.env.TELEGRAM_BOT_TOKEN = "t";
      process.env.RESEND_API_KEY = "r";
      process.env.VAPID_PUBLIC_KEY = "pub";
    }
  });

  it("counts an address whose owner muted activity mail, because a lesson's calendar mail goes anyway", async () => {
    const p = await makePlayer(db, "Muted");
    expect((await reachFor(db, { ...p, email: "a@b.co" })).email).toBe(true);
  });
});

describe("the coach's own copy of the lesson", () => {
  const lesson = { id: "11111111-1111-4111-8111-111111111111", startsAt: new Date("2026-10-01T03:00:00.000Z"), minutes: 60 } as never;
  const coach = { handle: "ricardo", displayName: "Ricardo", clubNames: ["Warehaus"] } as never;
  const student = { displayName: "Erik", email: "erik@example.com" } as never;
  // An address lands past the 73-character fold, so it is split across two lines in the file. Every
  // calendar client joins them back before reading; a test that does not is testing the folding.
  const unfolded = (ics: string) => ics.replace(/\r\n /g, "");

  it("puts the coach on the invitation, so their own calendar shows them on it", () => {
    const ics = unfolded(lessonIcs({ lesson, coach, student, title: "Erik", method: "REQUEST", coachEmail: "ricardo@example.com" }));
    expect(ics).toContain("mailto:ricardo@example.com");
    expect(ics).toContain("mailto:erik@example.com");
  });

  it("leaves the student's copy exactly as it was", () => {
    const ics = unfolded(lessonIcs({ lesson, coach, student, title: "Erik", method: "REQUEST" }));
    expect(ics).not.toContain("ricardo@example.com");
    expect(ics).toContain("mailto:erik@example.com");
  });

  it("cancels by the same identity, so the entry is removed and not doubled", () => {
    const ics = unfolded(lessonIcs({ lesson, coach, student, title: "Erik", method: "CANCEL", coachEmail: "ricardo@example.com" }));
    expect(ics).toContain("UID:lesson-11111111-1111-4111-8111-111111111111@");
    expect(ics).toContain("METHOD:CANCEL");
    expect(ics).toContain("STATUS:CANCELLED");
  });
});
