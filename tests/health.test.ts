import { describe, expect, it } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { getDb } from "@/db";
import { players } from "@/db/schema";

/**
 * The setup check is the one page that answers "is this deployment actually wired up?" — and for
 * four chat channels and the owner's own route it answered nothing at all. A note a player writes is
 * stored whether or not anyone is told about it, so "nobody is told" has to be visible from outside.
 *
 * `tests/helpers/setup.ts` puts `process.env` back when this file ends, so setting keys here is safe.
 */
describe("the setup check says what is wired up", () => {
  // `getDb()` and not `createTestDb()`: the route opens the app's own embedded database (see
  // tests/helpers/setup.ts), and a row written anywhere else is a row this page cannot see.

  const read = async () => (await (await health()).json()) as { channels: Record<string, string>; feedbackReachesOwner: boolean; owner: string | null; hints: string[] };

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

  it("names whose account everything for the owner goes to, not just that there is one", async () => {
    // "It reaches the owner: true" was true on the morning a player received an internal verdict on
    // his own note, because TELEGRAM_OWNER_ID named him. A boolean cannot show that; a name can.
    const db = await getDb();
    await db.insert(players).values({ displayName: "Eriik", locale: "en", telegramId: 424299 }).onConflictDoNothing();
    process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
    process.env.TELEGRAM_OWNER_ID = "424299";
    const body = await read();
    expect(body.feedbackReachesOwner).toBe(true);
    expect(body.owner).toBe("Eriik");
    expect(body.hints.some((h) => /goes to the Telegram account of Eriik/.test(h))).toBe(true);

    // An id nobody on the books answers to is not a name, and says nothing rather than guessing.
    process.env.TELEGRAM_OWNER_ID = "999000111";
    const stranger = await read();
    expect(stranger.feedbackReachesOwner).toBe(true);
    expect(stranger.owner).toBeNull();
    expect(stranger.hints.some((h) => /goes to the Telegram account of/.test(h))).toBe(false);
  });
});
