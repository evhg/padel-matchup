import { generateKeyPairSync, sign } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { discordCards, discordChannels, events, listenItems, players } from "@/db/schema";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { saveMatchScore } from "@/lib/domain/scores";
import { discordApplicationId, md, verifyInteraction, type DcInteraction } from "@/lib/discord/api";
import { channelTicket, handleInteraction, postCardForDiscordTicket, postDiscordResult, sendDiscordReminders, syncDiscord, verifyChannelTicket } from "@/lib/discord/bot";
import { discordListenTick, looksLikeQuestion } from "@/lib/discord/listen";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

// The first token segment is base64 of the application id (1545988138055237723 here); the rest is fake.
const TOKEN = "MTU0NTk4ODEzODA1NTIzNzcyMw.unit.fake";
const APP = "1545988138055237723";

type Call = { method: string; path: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let nextMessageId = 100;
let guilds: { id: string; name: string }[] = [];
let channels: Record<string, { id: string; type: number; name: string }[]> = {};
let messages: Record<string, Record<string, unknown>[]> = {};
let modelReply: Record<string, unknown> | null = null;

function stubDiscord() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      const path = u.pathname.replace(/^\/api\/v10/, "") + u.search;
      calls.push({ method, path, body });
      const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
      if (u.hostname === "api.anthropic.com") return json({ content: [{ type: "text", text: JSON.stringify(modelReply ?? { relevant: false, reply: null, reason: "stub" }) }], usage: { input_tokens: 100, output_tokens: 40 } });
      if (method === "POST" && /^\/channels\/\d+\/messages$/.test(u.pathname.replace(/^\/api\/v10/, ""))) return json({ id: String(nextMessageId++), channel_id: u.pathname.split("/")[4] });
      if (method === "PATCH" && /\/channels\/\d+\/messages\/\d+$/.test(u.pathname)) return json({ id: u.pathname.split("/").pop() });
      if (method === "PATCH" && /\/webhooks\//.test(u.pathname)) return json({ id: String(nextMessageId++) });
      if (u.pathname.endsWith("/users/@me/guilds")) return json(guilds);
      const g = u.pathname.match(/\/guilds\/(\d+)\/channels$/);
      if (g) return json(channels[g[1]] ?? []);
      const m = u.pathname.match(/\/channels\/(\d+)\/messages$/);
      if (m && method === "GET") {
        const after = u.searchParams.get("after");
        const all = messages[m[1]] ?? [];
        const limit = Number(u.searchParams.get("limit") ?? 50);
        const out = after ? all.filter((x) => BigInt(String(x.id)) > BigInt(after)) : all.slice(-limit);
        return json(out);
      }
      return json({ message: "not stubbed", code: 0 }, 404);
    }),
  );
}
const sent = (method: string, re: RegExp) => calls.filter((c) => c.method === method && re.test(c.path));
const posts = () => sent("POST", /^\/channels\/\d+\/messages$/);
const edits = () => sent("PATCH", /^\/channels\/\d+\/messages\/\d+$/);

const user = (id: number, name: string) => ({ id: String(id), username: name.toLowerCase(), global_name: name });
const GUILD = "1545987795863085087";
const CHANNEL = "1545987795863085090";
const command = (name: string, from: ReturnType<typeof user>, options: Record<string, string> = {}, o: { locale?: string; channel?: string } = {}): DcInteraction => ({
  id: String(Date.now()),
  application_id: APP,
  type: 2,
  token: "itoken",
  guild_id: GUILD,
  channel_id: o.channel ?? CHANNEL,
  channel: { id: o.channel ?? CHANNEL, type: 0, name: "padel" },
  member: { user: from },
  locale: o.locale ?? "en-US",
  data: { name, options: Object.entries(options).map(([k, v]) => ({ name: k, type: 3, value: v })) },
});
const button = (customId: string, from: ReturnType<typeof user>, messageId: string, o: { channel?: string } = {}): DcInteraction => ({
  id: String(Date.now()),
  application_id: APP,
  type: 3,
  token: "itoken",
  guild_id: GUILD,
  channel_id: o.channel ?? CHANNEL,
  member: { user: from },
  message: { id: messageId, channel_id: o.channel ?? CHANNEL },
  data: { custom_id: customId, component_type: 2 },
});

describe("discord signatures, tickets, helpers", () => {
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = TOKEN;
  });
  it("verifies the Ed25519 signature over timestamp + body and rejects anything else", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const body = JSON.stringify({ type: 1 });
    const ts = "1757130000";
    const sig = sign(null, Buffer.from(ts + body), privateKey).toString("hex");
    expect(verifyInteraction(sig, ts, body, pub)).toBe(true);
    expect(verifyInteraction(sig, ts, body + " ", pub)).toBe(false);
    expect(verifyInteraction(sig, "1757130001", body, pub)).toBe(false);
    expect(verifyInteraction(sig.replace(/^../, "00"), ts, body, pub)).toBe(false);
    expect(verifyInteraction("zz", ts, body, pub)).toBe(false);
    expect(verifyInteraction(sig, ts, body, "00".repeat(32))).toBe(false);
    expect(verifyInteraction(null, ts, body, pub)).toBe(false);
  });
  it("channel tickets are bound to the channel and expire after two days", () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const t = channelTicket(CHANNEL, now);
    expect(verifyChannelTicket(t, now)).toBe(CHANNEL);
    expect(verifyChannelTicket(t, new Date(now.getTime() + 20 * HOUR))).toBe(CHANNEL);
    expect(verifyChannelTicket(t, new Date(now.getTime() + 3 * 24 * HOUR))).toBeNull();
    expect(verifyChannelTicket(t.replace(CHANNEL, "1545987795863085091"), now)).toBeNull();
    expect(verifyChannelTicket("abc.1.x", now)).toBeNull();
    expect(verifyChannelTicket(undefined, now)).toBeNull();
  });
  it("reads the application id out of the token and escapes markdown", () => {
    expect(discordApplicationId()).toBe(APP);
    expect(md("a_b *c* ~d~")).toBe("a\\_b \\*c\\* \\~d\\~");
  });
  it("gates messages cheaply: humans, sentences, questions or requests, mentions of the bot", () => {
    expect(looksLikeQuestion({ content: "How do I run a mexicano with 8 players?", author: user(1, "A") }, APP)).toBe(true);
    expect(looksLikeQuestion({ content: "Подскажите, как работает лист ожидания", author: user(1, "A") }, APP)).toBe(true);
    expect(looksLikeQuestion({ content: "gg", author: user(1, "A") }, APP)).toBe(false);
    expect(looksLikeQuestion({ content: "see you all at the court tonight then", author: user(1, "A") }, APP)).toBe(false);
    expect(looksLikeQuestion({ content: `<@${APP}> level ranges please`, author: user(1, "A") }, APP)).toBe(true);
    expect(looksLikeQuestion({ content: "How does this work?", author: { ...user(1, "A"), bot: true } }, APP)).toBe(false);
    expect(looksLikeQuestion({ content: "How does this work?", author: user(1, "A"), type: 20 }, APP)).toBe(false);
  });
});

describe("discord bot (db, stubbed REST)", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => {
    await close();
    delete process.env.DISCORD_BOT_TOKEN;
    delete process.env.DISCORD_PUBLIC_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });
  beforeEach(() => {
    process.env.DISCORD_BOT_TOKEN = TOKEN;
    process.env.DISCORD_PUBLIC_KEY = "00".repeat(32);
    delete process.env.ANTHROPIC_API_KEY;
    guilds = [];
    channels = {};
    messages = {};
    modelReply = null;
    stubDiscord();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function match(startsAt = new Date(Date.now() + 3 * HOUR)) {
    const org = await makePlayer(db, "Olga");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt, tz: "Asia/Bangkok", venueName: "Rawai Padel Club", court: "2", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    return { org, ev };
  }
  const field = (c: Call) => ((c.body?.embeds as { fields: { name: string; value: string }[] }[])[0].fields[0]);

  it("/match posts the card; buttons join and leave update it in place; one complete note; waitlist gets a private note", async () => {
    const { ev } = await match();
    const ivan = user(1, "Ivan");
    const posted = await handleInteraction(db, command("match", ivan, { code: `https://kicksma.sh/${ev.code}` }), NO_SIDE_EFFECTS);
    expect(posted.outcome).toBe("card");
    expect(posted.response.data?.flags).toBe(64);
    expect(posts()).toHaveLength(1);
    expect(field(posts()[0]).name).toBe("Players 1/4");
    expect(JSON.stringify(posts()[0].body?.components)).toContain(`j:${ev.code}`);
    const [row] = await db.select().from(discordCards).where(eq(discordCards.eventId, ev.id));
    expect(row.channelId).toBe(CHANNEL);
    expect(row.messageId).toBe("100");

    const petr = user(2, "Petr");
    const tap = await handleInteraction(db, button(`j:${ev.code}`, petr, row.messageId), NO_SIDE_EFFECTS);
    expect(tap.outcome).toBe("join:joined");
    expect(tap.response.type).toBe(7);
    expect((tap.response.data?.embeds ?? [])[0].fields?.[0].name).toBe("Players 2/4");
    await tap.followUp?.();
    expect(edits()).toHaveLength(0); // the tapped card was answered in place, nothing else to edit
    const [p] = await db.select().from(players).where(eq(players.discordId, "2"));
    expect(p.displayName).toBe("Petr");
    expect(p.discordUsername).toBe("petr");

    const again = await handleInteraction(db, button(`j:${ev.code}`, petr, row.messageId), NO_SIDE_EFFECTS);
    expect(again.outcome).toBe("join:already_in");
    expect(again.response.type).toBe(4);
    expect(again.response.data?.flags).toBe(64);
    expect(again.response.data?.content).toBe("You're already in.");

    const left = await handleInteraction(db, button(`l:${ev.code}`, petr, row.messageId), NO_SIDE_EFFECTS);
    expect(left.outcome).toBe("leave:left");
    expect(left.response.type).toBe(7);
    const stranger = await handleInteraction(db, button(`l:${ev.code}`, user(3, "Sasha"), row.messageId), NO_SIDE_EFFECTS);
    expect(stranger.outcome).toBe("leave:not_in");
    expect(stranger.response.data?.content).toBe("You weren't in this match.");

    for (const u of [user(4, "Dima"), user(5, "Kolya"), user(6, "Misha")]) {
      const r = await handleInteraction(db, button(`j:${ev.code}`, u, row.messageId), NO_SIDE_EFFECTS);
      await r.followUp?.();
    }
    const notes = posts().filter((c) => String(c.body?.content ?? "").includes("Line-up complete"));
    expect(notes).toHaveLength(1);
    expect(notes[0].body?.message_reference).toMatchObject({ message_id: row.messageId });
    const late = await handleInteraction(db, button(`j:${ev.code}`, user(7, "Zhenya"), row.messageId), NO_SIDE_EFFECTS);
    expect(late.outcome).toBe("join:waitlisted");
    expect(late.response.data?.content).toBe("Full for now. You're on the waitlist.");
    await late.followUp?.();
    expect(field(edits().at(-1)!).value).toContain("Waitlist: 1");
    expect(posts().filter((c) => String(c.body?.content ?? "").includes("Line-up complete"))).toHaveLength(1);
  });

  it("/new hands out a ticket that posts the card after creation; /lang and /help; unknown codes", async () => {
    const lee = user(9, "Lee");
    const chan = "1545987795863085099";
    const r = await handleInteraction(db, command("new", lee, {}, { channel: chan }), NO_SIDE_EFFECTS);
    expect(r.outcome).toBe("new");
    const url = (r.response.data?.components ?? [])[0].components[0].url!;
    const ticket = new URL(url).searchParams.get("dc")!;
    expect(verifyChannelTicket(ticket)).toBe(chan);
    const { ev } = await match();
    expect(await postCardForDiscordTicket(db, ev.code, ticket)).toBe(true);
    expect(await postCardForDiscordTicket(db, ev.code, "bad.ticket.x")).toBe(false);
    expect(field(posts().at(-1)!).name).toBe("Players 1/4");
    expect(posts().at(-1)!.path).toBe(`/channels/${chan}/messages`);
    expect((await handleInteraction(db, command("lang", lee, { language: "ru" }, { channel: chan }), NO_SIDE_EFFECTS)).outcome).toBe("lang");
    const [row] = await db.select().from(discordChannels).where(eq(discordChannels.channelId, chan));
    expect(row.locale).toBe("ru");
    const help = await handleInteraction(db, command("help", lee, {}, { channel: chan }), NO_SIDE_EFFECTS);
    expect(help.response.data?.content).toContain("/new создаёт");
    expect((await handleInteraction(db, command("match", lee, { code: "ZZZZ" }, { channel: chan }), NO_SIDE_EFFECTS)).outcome).toBe("match_unknown");
    expect((await handleInteraction(db, { id: "1", application_id: APP, type: 1, token: "t" }, NO_SIDE_EFFECTS)).response).toEqual({ type: 1 });
    // The card follows the channel language once synced.
    await syncDiscord(db, ev.code);
    expect(field(edits().at(-1)!).name).toBe("Игроки 1/4");
  });

  it("reminds about an hour before, once, and posts the result once the organizer confirms", async () => {
    const chan = "1545987795863085077";
    const now = new Date("2026-09-06T10:00:00Z");
    const { org, ev } = await match(new Date(now.getTime() + 70 * 60 * 1000));
    await handleInteraction(db, command("match", user(11, "Max"), { code: ev.code }, { channel: chan }), NO_SIDE_EFFECTS);
    expect(await sendDiscordReminders(db, new Date(now.getTime() - 3 * HOUR))).toBe(0);
    expect(await sendDiscordReminders(db, now)).toBe(1);
    expect(String(posts().at(-1)!.body?.content)).toContain("⏰");
    expect(await sendDiscordReminders(db, now)).toBe(0);
    expect(await postDiscordResult(db, ev.code)).toBe(0);
    for (const name of ["A", "B", "C"]) {
      const p = await makePlayer(db, name);
      await joinEvent(db, { eventId: ev.id, playerId: p.id });
    }
    await db.update(events).set({ startsAt: new Date(now.getTime() - 3 * HOUR) }).where(eq(events.id, ev.id));
    await saveMatchScore(db, { eventId: ev.id, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }], playerId: org.id, isCreator: true, now });
    expect(await postDiscordResult(db, ev.code)).toBe(1);
    const result = posts().at(-1)!;
    expect(JSON.stringify(result.body?.embeds)).toContain("opengraph-image");
    expect(await postDiscordResult(db, ev.code)).toBe(0);
  });

  it("/ask defers, answers through the model and records the reply; without a key it says so", async () => {
    const chan = "1545987795863085066";
    const q = command("ask", user(21, "Nina"), { question: "How does a mexicano decide who plays whom?" }, { channel: chan });
    const dry = await handleInteraction(db, q, NO_SIDE_EFFECTS);
    expect(dry.response.type).toBe(5);
    await dry.followUp?.();
    const first = sent("PATCH", /\/webhooks\//).at(-1)!;
    expect(String(first.body?.content)).toContain("I don't have a good answer");
    process.env.ANTHROPIC_API_KEY = "sk-test";
    modelReply = { relevant: true, kind: "asks_how_to", language: "en", reply: "Round one is random; after that courts follow the standings and 1st+4th play 2nd+3rd on each court.", reason: "format question", mentionsKicksmash: false };
    const wet = await handleInteraction(db, q, NO_SIDE_EFFECTS);
    await wet.followUp?.();
    const answered = sent("PATCH", /\/webhooks\//).at(-1)!;
    expect(String(answered.body?.content)).toContain("**Nina:**");
    expect(String(answered.body?.content)).toContain("courts follow the standings");
    const items = await db.select().from(listenItems).where(eq(listenItems.source, "discord"));
    const posted = items.filter((i) => i.status === "posted");
    expect(posted).toHaveLength(1);
    expect(posted[0].replyUrl).toContain(`/channels/${GUILD}/${chan}/`);
    const short = await handleInteraction(db, command("ask", user(21, "Nina"), { question: "hm?" }, { channel: chan }), NO_SIDE_EFFECTS);
    expect(short.outcome).toBe("ask_short");
  });

  it("the hourly read sets the cursor first, then answers new questions once and skips chatter", async () => {
    const chan = "1545987795863085055";
    guilds = [{ id: GUILD, name: "KickSmash" }];
    channels[GUILD] = [
      { id: chan, type: 0, name: "general" },
      { id: "1545987795863085056", type: 2, name: "voice" },
    ];
    messages[chan] = [{ id: "500", type: 0, content: "How do I set a level range?", author: user(31, "Old") }];
    process.env.ANTHROPIC_API_KEY = "sk-test";
    modelReply = { relevant: true, kind: "asks_how_to", language: "en", reply: "Open More options on the create form and pick a range.", reason: "how-to", mentionsKicksmash: true };
    const now = new Date("2026-09-07T10:00:00Z");
    const first = await discordListenTick(db, now);
    expect(first.guilds).toBe(1);
    expect(first.channels).toBe(1);
    expect(first.read).toBe(0);
    expect(first.replied).toBe(0);
    expect(sent("POST", /api\.anthropic|\/v1\/messages/)).toHaveLength(0);
    const [row] = await db.select().from(discordChannels).where(eq(discordChannels.channelId, chan));
    expect(row.lastMessageId).toBe("500");
    expect(row.guildName).toBe("KickSmash");

    messages[chan].push({ id: "501", type: 0, content: "hi everyone", author: user(32, "Petr") }, { id: "502", type: 0, content: "How do I run a mexicano with 8 players on 2 courts?", author: user(32, "Petr") }, { id: "503", type: 0, content: "How does this work?", author: { ...user(33, "Bot"), bot: true } });
    const second = await discordListenTick(db, now);
    expect(second.read).toBe(3);
    expect(second.candidates).toBe(1);
    expect(second.replied).toBe(1);
    const reply = posts().at(-1)!;
    expect(reply.path).toBe(`/channels/${chan}/messages`);
    expect(reply.body?.message_reference).toMatchObject({ message_id: "502" });
    expect(String(reply.body?.content)).toContain("pick a range");
    const items = await db.select().from(listenItems).where(eq(listenItems.externalId, `${chan}:502`));
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("posted");
    expect(items[0].author).toBe("Petr");
    const [after] = await db.select().from(discordChannels).where(eq(discordChannels.channelId, chan));
    expect(after.lastMessageId).toBe("503");

    const before = calls.length;
    const third = await discordListenTick(db, now);
    expect(third.read).toBe(0);
    expect(posts().length).toBe(1);
    expect(calls.length - before).toBe(3); // guilds, channels, one messages call

    // A question the model finds not worth answering: nothing posted, remembered as irrelevant.
    modelReply = { relevant: false, kind: "other", language: "en", reply: null, reason: "arranging a game", mentionsKicksmash: false };
    messages[chan].push({ id: "504", type: 0, content: "Who wants to play tomorrow at 7?", author: user(32, "Petr") });
    const fourth = await discordListenTick(db, now);
    expect(fourth.candidates).toBe(1);
    expect(fourth.replied).toBe(0);
    expect(posts().length).toBe(1);
    const [skipped] = await db.select().from(listenItems).where(eq(listenItems.externalId, `${chan}:504`));
    expect(skipped.status).toBe("irrelevant");

    // Disabled without a token: nothing at all.
    delete process.env.DISCORD_BOT_TOKEN;
    const off = await discordListenTick(db, now);
    expect(off).toMatchObject({ guilds: 0, channels: 0, replied: 0 });
  });
});
