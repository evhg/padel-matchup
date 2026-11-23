import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { matchReels } from "@/db/schema";
import { REEL_KEEP_DAYS, isReelToken, matchReel, reelHostOf, reelView, removeMatchReel, setMatchReel } from "@/lib/domain/matchReel";
import { recordPlayedMatch } from "@/lib/domain/playedMatch";
import { createTestDb, DAY } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const NOW = new Date("2026-11-23T08:00:00Z");
const HOST = "https://reels.example.test";
const TOKEN = "Zx9-token_of_22_chars_min";

describe("the address of a reel", () => {
  it("keeps the reel host as https and a host name, with no path and no slash", () => {
    expect(reelHostOf("https://reels.example.test/")).toBe(HOST);
    expect(reelHostOf(" https://reels.example.test ")).toBe(HOST);
    for (const bad of ["http://reels.example.test", "https://reels.example.test/r/x", "https://u:p@reels.example.test", "https://reels.example.test?x=1", "reels.example.test", "", null, 7]) expect(reelHostOf(bad), String(bad)).toBeNull();
  });

  it("takes a token of 22 to 64 characters that can stand in a path, and nothing else", () => {
    expect(isReelToken(TOKEN)).toBe(true);
    for (const bad of ["short", "a".repeat(65), "with/slash_with/slash_with", "with.dot_with.dot_with.dot", "..%2F..%2Fmatch2%2Fvideo", null]) expect(isReelToken(bad), String(bad)).toBe(false);
  });

  it("shows a reel only when it is ready, and only for its 30 days", () => {
    const row = { status: "ready", host: HOST, reelToken: TOKEN, readyAt: NOW };
    expect(REEL_KEEP_DAYS).toBe(30);
    expect(reelView(row, NOW)).toEqual({
      tall: `${HOST}/r/${TOKEN}/tall.mp4`,
      wide: `${HOST}/r/${TOKEN}/wide.mp4`,
      saveTall: `${HOST}/r/${TOKEN}/tall.mp4?dl=1`,
      saveWide: `${HOST}/r/${TOKEN}/wide.mp4?dl=1`,
      keptUntil: new Date(NOW.getTime() + 30 * DAY),
    });
    expect(reelView(row, new Date(NOW.getTime() + 30 * DAY - 1))).not.toBeNull();
    expect(reelView(row, new Date(NOW.getTime() + 30 * DAY))).toBeNull();
    expect(reelView({ ...row, status: "working" }, NOW)).toBeNull();
    expect(reelView({ ...row, readyAt: null }, NOW)).toBeNull();
    expect(reelView({ ...row, host: "http://reels.example.test" }, NOW)).toBeNull();
    expect(reelView(null, NOW)).toBeNull();
  });
});

describe("the reel of a match", () => {
  const played = () => recordPlayedMatch(db, { startsAt: new Date(NOW.getTime() - 5 * DAY), tz: "Asia/Bangkok", venueName: "Reel Club", teamA: ["Ana", "Bo"], teamB: ["Cy", "Di"], sets: [{ sideA: 6, sideB: 3 }, { sideA: 6, sideB: 2 }], now: NOW });

  it("is written as ready by the operator, read by the match page, replaced by a second call and taken down", async () => {
    const { code } = await played();
    const first = await setMatchReel(db, { code, host: `${HOST}/`, token: TOKEN, now: NOW });
    expect(first.replaced).toBe(false);
    expect((await matchReel(db, first.eventId, NOW))?.tall).toBe(`${HOST}/r/${TOKEN}/tall.mp4`);
    const [row] = await db.select().from(matchReels).where(eq(matchReels.eventId, first.eventId));
    expect(row).toMatchObject({ status: "ready", host: HOST, reelToken: TOKEN, source: "operator" });

    const other = "another_token_of_22_chars";
    const later = new Date(NOW.getTime() + DAY);
    expect((await setMatchReel(db, { code, host: HOST, token: other, now: later })).replaced).toBe(true);
    expect((await db.select().from(matchReels).where(eq(matchReels.eventId, first.eventId))).length).toBe(1);
    expect((await matchReel(db, first.eventId, later))?.keptUntil).toEqual(new Date(later.getTime() + 30 * DAY));

    expect(await removeMatchReel(db, code)).toBe(true);
    expect(await matchReel(db, first.eventId, later)).toBeNull();
    expect(await removeMatchReel(db, code)).toBe(false);
  });

  it("refuses a host that is not https, a token of the wrong shape and a match it does not know, each before any write", async () => {
    const { code } = await played();
    const count = async () => (await db.select({ id: matchReels.id }).from(matchReels)).length;
    const before = await count();
    await expect(setMatchReel(db, { code, host: "http://reels.example.test", token: TOKEN, now: NOW })).rejects.toMatchObject({ code: "invalid" });
    await expect(setMatchReel(db, { code, host: HOST, token: "short", now: NOW })).rejects.toMatchObject({ code: "invalid" });
    await expect(setMatchReel(db, { code: "none", host: HOST, token: TOKEN, now: NOW })).rejects.toMatchObject({ code: "not_found" });
    await expect(removeMatchReel(db, "none")).rejects.toMatchObject({ code: "not_found" });
    expect(await count()).toBe(before);
  });
});
