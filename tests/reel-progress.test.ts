import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, matchReels, notices } from "@/db/schema";
import { progressOf, reelState, reelStateOf, reelStillAt, reelStillDataUrl, setMatchReel, setReelProgress } from "@/lib/domain/matchReel";
import { recordPlayedMatch } from "@/lib/domain/playedMatch";
import { cardVersion } from "@/lib/resultCard";
import { getEventByCode } from "@/lib/domain/queries";
import { notifyReelReady } from "@/lib/notify";
import { createTestDb, makePlayer } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

// 24 November 2026, 18:00 in Bangkok.
const NOW = new Date("2026-11-24T11:00:00Z");
const HOST = "https://reels.example.test";
const TOKEN = "r".repeat(32);

async function playedMatch(tag: string) {
  const [a, b, c, d] = [await makePlayer(db, `A ${tag}`), await makePlayer(db, `B ${tag}`), await makePlayer(db, `C ${tag}`), await makePlayer(db, `D ${tag}`)];
  const m = await recordPlayedMatch(db, { startsAt: new Date("2026-11-24T02:30:00Z"), tz: "Asia/Bangkok", durationMinutes: 90, teamA: [a.id, b.id], teamB: [c.id, d.id], sets: [{ sideA: 6, sideB: 3 }], now: NOW });
  const [ev] = await db.select().from(events).where(eq(events.code, m.code));
  return ev;
}

describe("a reel in the making", () => {
  it("reads only a sane progress from the note", () => {
    expect(progressOf(JSON.stringify({ pct: 140, readyBy: "2026-11-24T11:20:00Z", step: "follow" }))).toEqual({ pct: 100, readyBy: new Date("2026-11-24T11:20:00Z"), step: "follow", names: null });
    expect(progressOf(JSON.stringify({ pct: 40, readyBy: "2026-11-24T11:20:00Z", step: "<b>made up</b>" }))?.step).toBeNull();
    expect(progressOf("not json")).toBeNull();
    expect(progressOf(null)).toBeNull();
  });

  it("takes a shown reel off the page, shows the bar and the minutes, and shows the new reel when it comes", async () => {
    const ev = await playedMatch("one");
    await setMatchReel(db, { code: ev.code, host: HOST, token: TOKEN, now: NOW });
    expect((await reelState(db, ev.id, NOW)).kind).toBe("ready");

    await setReelProgress(db, { code: ev.code, pct: 35, minutesLeft: 20, step: "follow", now: NOW });
    const working = await reelState(db, ev.id, NOW);
    expect(working).toEqual({ kind: "working", progress: { pct: 35, readyBy: new Date(NOW.getTime() + 20 * 60_000), step: "follow", names: null } });
    // A working row with no progress in its note is not a bar: the page says plainly that a person makes it.
    expect(reelStateOf({ status: "working", host: null, reelToken: TOKEN, readyAt: null, source: "clips", note: null }, NOW)).toEqual({ kind: "here", source: "clips" });

    await setMatchReel(db, { code: ev.code, host: HOST, token: "s".repeat(32), now: NOW });
    expect((await reelState(db, ev.id, NOW)).kind).toBe("ready");
  });

  it("refuses a progress that is not one, and a match that has not started", async () => {
    const ev = await playedMatch("two");
    // A match played but with no row yet (the second match of the same clips) gets one: its page shows the bar too.
    await setReelProgress(db, { code: ev.code, pct: 20, minutesLeft: 5, now: NOW });
    expect((await reelState(db, ev.id, NOW)).kind).toBe("working");
    await expect(setReelProgress(db, { code: ev.code, pct: 20, minutesLeft: 5, now: new Date("2026-11-24T01:00:00Z") })).resolves.toBeTruthy();
    await db.delete(matchReels).where(eq(matchReels.eventId, ev.id));
    await expect(setReelProgress(db, { code: ev.code, pct: 20, minutesLeft: 5, now: new Date("2026-11-24T01:00:00Z") })).rejects.toMatchObject({ code: "not_found" });
    await db.insert(matchReels).values({ eventId: ev.id, status: "received", reelToken: TOKEN, source: "clips" });
    await expect(setReelProgress(db, { code: ev.code, pct: "x", minutesLeft: 5, now: NOW })).rejects.toMatchObject({ code: "invalid" });
    await expect(setReelProgress(db, { code: ev.code, pct: 20, minutesLeft: -1, now: NOW })).rejects.toMatchObject({ code: "invalid" });
  });
});

describe("the card without a court photo", () => {
  it("takes the versus frame of a ready reel, and a new version when it does", async () => {
    const ev = await playedMatch("three");
    expect(await reelStillAt(db, ev.id, NOW)).toBeNull();
    await setMatchReel(db, { code: ev.code, host: HOST, token: TOKEN, now: NOW });
    const at = await reelStillAt(db, ev.id, NOW);
    expect(at).not.toBeNull();
    const detail = (await getEventByCode(db, ev.code))!;
    expect(cardVersion(detail, null, at)).toContain("-s");
    expect(cardVersion(detail, { createdAt: NOW }, at)).toContain("-p");
    let asked = "";
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const got = await reelStillDataUrl(db, ev.id, NOW, (async (url: string) => {
      asked = url;
      return new Response(jpeg, { headers: { "content-type": "image/jpeg" } });
    }) as unknown as typeof fetch);
    expect(asked).toBe(`${HOST}/r/${TOKEN}/versus.jpg`);
    expect(got).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
    const none = await reelStillDataUrl(db, ev.id, NOW, (async () => new Response("no", { status: 404 })) as unknown as typeof fetch);
    expect(none).toBeNull();
  });
});

describe("the players hear of the reel", () => {
  it("once, all four, in the inbox; a new cut of the reel is not news", async () => {
    const ev = await playedMatch("four");
    const first = await setMatchReel(db, { code: ev.code, host: HOST, token: TOKEN, now: NOW });
    expect(first.first).toBe(true);
    expect(await notifyReelReady(db, ev)).toBe(4);
    const told = await db.select().from(notices).where(eq(notices.eventId, ev.id));
    expect(told.map((n) => n.key)).toEqual(Array(4).fill("noticeItem.reelReady"));
    expect(new Set(told.map((n) => n.playerId)).size).toBe(4);

    await setReelProgress(db, { code: ev.code, pct: 10, minutesLeft: 30, step: "clips", now: NOW });
    expect((await setMatchReel(db, { code: ev.code, host: HOST, token: "t".repeat(32), now: NOW })).first).toBe(false);
    expect((await setMatchReel(db, { code: ev.code, host: HOST, token: TOKEN, now: NOW })).first).toBe(false);
  });
});
