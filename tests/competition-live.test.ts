import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { addCategory, categoriesOf, createCompetition, enterPair } from "@/lib/domain/competitions";
import { competitionDraws, enterMatchScore, makeDraw, publishDraw } from "@/lib/domain/competitionDraw";
import { awardCompetitionPodium, liveBoard } from "@/lib/domain/competitionLive";
import { orderOfPlay, scheduleCompetition, setCourts } from "@/lib/domain/competitionSchedule";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import { packId } from "@/lib/telegram/taps";
import { freezeClock } from "./helpers/clock";
import { createTestDb, makePlayer } from "./helpers/db";

/** Tuesday 8 September 2026, 16:00 in Phuket; play on Saturday 10 October. */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);

type Call = { method: string; body: Record<string, unknown> };
let calls: Call[] = [];
function stubTelegram() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const method = String(url).split("/").pop()!;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push({ method, body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: body.chat_id } } }), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}
const texts = () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.body.text));

describe("the tournament live", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());
  afterEach(() => vi.unstubAllGlobals());

  it("shows each court's match now and next, takes a score by reply in the chat, and awards the podium once", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:TESTTOKEN";
    stubTelegram();
    const org = await makePlayer(db, "Org");
    const c = await createCompetition(db, { organizerPlayerId: org.id, name: "Live Open", tz: "Asia/Bangkok", startsOn: "2026-10-10", endsOn: "2026-10-10" });
    const gold = await addCategory(db, { competitionId: c.id, organizerPlayerId: org.id, name: "Gold", maxPairs: 8 });
    const people: { player: Awaited<ReturnType<typeof makePlayer>>; pair: string }[] = [];
    for (let i = 1; i <= 8; i++) {
      const player = await makePlayer(db, `L${i}`, { telegramId: `55${i}` });
      const e = await enterPair(db, { categoryId: gold.id, playerId: player.id, partner: { name: `LM${i}` }, locale: "en", byOrganizer: true });
      people.push({ player, pair: e.pair.id });
    }
    await makeDraw(db, { categoryId: gold.id, organizerPlayerId: org.id, now: NOW });
    await publishDraw(db, { categoryId: gold.id, organizerPlayerId: org.id });
    await setCourts(db, { competitionId: c.id, organizerPlayerId: org.id, courtNames: ["Court 1", "Court 2"], dayStart: "09:00", dayEnd: "21:00" });
    await scheduleCompetition(db, { competitionId: c.id, organizerPlayerId: org.id, now: NOW });
    const categories = await categoriesOf(db, c.id);

    // Before play: nothing now, the first matches next. Five past nine: both courts busy.
    const early = await liveBoard(db, c.id, c.courtNames ?? ["Court 1", "Court 2"], categories, new Date("2026-10-10T01:00:00Z"));
    expect(early.courts.map((k) => [k.courtName, k.now, k.next?.scheduledAt?.toISOString()])).toEqual([
      ["Court 1", null, "2026-10-10T02:00:00.000Z"],
      ["Court 2", null, "2026-10-10T02:00:00.000Z"],
    ]);
    const nine = await liveBoard(db, c.id, ["Court 1", "Court 2"], categories, new Date("2026-10-10T02:05:00Z"));
    expect(nine.courts.every((k) => k.now && k.next && k.next.id !== k.now.id)).toBe(true);
    expect(nine.latest).toEqual([]);
    expect(nine.champions).toEqual([]);

    // A player answers the "in 15 minutes" notice with the score: the reply names the match.
    const play = await orderOfPlay(db, c.id);
    const first = play[0];
    const mine = people.find((p) => first.aPlayers.includes(p.player.id) || first.bPlayers.includes(p.player.id))!;
    const stranger = people.find((p) => !first.aPlayers.includes(p.player.id) && !first.bPlayers.includes(p.player.id))!;
    const notice = { message_id: 7, date: 0, chat: { id: Number(mine.player.telegramId), type: "private" as const, first_name: "L" }, from: { id: 123456, is_bot: true, first_name: "Kicksmash" }, text: `In 15 minutes: Court 1\nGold vs X at Live Open.\n↳ ks:${packId(first.id)}` };
    const reply = (tgId: string, text: string, id: number) =>
      handleTelegramUpdate(db, { update_id: id, message: { message_id: id, date: 0, chat: { id: Number(tgId), type: "private", first_name: "L" }, from: { id: Number(tgId), first_name: "L", language_code: "en" }, text, reply_to_message: { ...notice, chat: { id: Number(tgId), type: "private", first_name: "L" } } } }, NO_SIDE_EFFECTS);
    expect(await reply(stranger.player.telegramId!, "6-4", 1)).toBe("tournament:score:refused");
    expect(texts().at(-1)).toContain("not yours");
    expect(await reply(mine.player.telegramId!, "6-5", 2)).toBe("tournament:score:refused");
    expect(texts().at(-1)).toContain("One set to 6");
    expect(await reply(mine.player.telegramId!, "hello", 3)).toBe("tournament:score:help");
    expect(await reply(mine.player.telegramId!, "6-4", 4)).toBe("tournament:score:saved");
    expect(texts().at(-1)).toContain("Saved: 6-4");
    const after = await liveBoard(db, c.id, ["Court 1", "Court 2"], categories, new Date("2026-10-10T02:05:00Z"));
    expect(after.latest.map((m) => m.id)).toEqual([first.id]);

    // Play the rest from the desk, through to the final: the podium is awarded once, to every player on it.
    let view = (await competitionDraws(db, c.id, categories)).get(gold.id)!;
    for (const m of view.groups.flatMap((g) => g.matches).filter((m) => m.status !== "done")) await enterMatchScore(db, { matchId: m.id, actorPlayerId: org.id, scoreA: [6], scoreB: [2] });
    view = (await competitionDraws(db, c.id, categories)).get(gold.id)!;
    for (const m of view.main[0]) await enterMatchScore(db, { matchId: m.id, actorPlayerId: org.id, scoreA: [9], scoreB: [5] });
    view = (await competitionDraws(db, c.id, categories)).get(gold.id)!;
    expect(await awardCompetitionPodium(db, gold.id)).toEqual([]); // not done yet
    await enterMatchScore(db, { matchId: view.main[1][0].id, actorPlayerId: org.id, scoreA: [6, 6], scoreB: [3, 4] });
    const awards = await awardCompetitionPodium(db, gold.id);
    expect(awards.map((a) => a.place).sort()).toEqual([1, 1, 2, 2, 3, 3, 3, 3]);
    expect(awards.every((a) => a.milestone.kind === "podium" && a.milestone.value.startsWith(`competition:${gold.id}:`) && a.partnerName.length > 0)).toBe(true);
    expect(await awardCompetitionPodium(db, gold.id)).toEqual([]);
    const done = await liveBoard(db, c.id, ["Court 1", "Court 2"], categories.map((k) => ({ ...k, drawStatus: "done" as const })), new Date("2026-10-10T12:00:00Z"));
    expect(done.champions).toEqual([{ categoryName: "Gold", name: expect.stringMatching(/ & /) }]);
  });
});
