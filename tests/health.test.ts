import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GET as health } from "@/app/api/health/route";
import type { Db } from "@/db";
import { createTestDb } from "./helpers/db";

/**
 * The setup check is the one page that answers "is this deployment actually wired up?" — and for
 * four chat channels and the owner's own route it answered nothing at all. A note a player writes is
 * stored whether or not anyone is told about it, so "nobody is told" has to be visible from outside.
 *
 * `tests/helpers/setup.ts` puts `process.env` back when this file ends, so setting keys here is safe.
 */
describe("the setup check says what is wired up", () => {
  let close: () => Promise<void>;
  // The route opens the database itself; this is what makes one available to it.
  let db: Db;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    expect(db).toBeTruthy();
  });
  afterAll(async () => close());

  const read = async () => (await (await health()).json()) as { channels: Record<string, string>; feedbackReachesOwner: boolean; hints: string[] };

  it("names every chat channel, and says off rather than leaving it out", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.LINE_CHANNEL_TOKEN;
    delete process.env.WHATSAPP_TOKEN;
    const body = await read();
    expect(Object.keys(body.channels).sort()).toEqual(["discord", "line", "telegram", "whatsapp"]);
    expect(Object.values(body.channels).every((v) => v === "off")).toBe(true);
    expect(body.hints.some((h) => /channels are off/.test(h))).toBe(true);
  });

  it("says plainly when nothing reaches the owner, and why", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_OWNER_ID = "12345";
    const noBot = await read();
    expect(noBot.feedbackReachesOwner).toBe(false);
    expect(noBot.hints.some((h) => /Nothing reaches the owner: the Telegram bot is off/.test(h))).toBe(true);

    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
    delete process.env.TELEGRAM_OWNER_ID;
    const noOwner = await read();
    expect(noOwner.feedbackReachesOwner).toBe(false);
    expect(noOwner.hints.some((h) => /TELEGRAM_OWNER_ID is not set/.test(h))).toBe(true);
  });

  it("is happy only when both halves of that route are there", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
    process.env.TELEGRAM_OWNER_ID = "12345";
    const body = await read();
    expect(body.feedbackReachesOwner).toBe(true);
    expect(body.channels.telegram).toBe("on");
    expect(body.hints.some((h) => /reaches the owner/.test(h))).toBe(false);
  });
});
