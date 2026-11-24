import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, matchReels } from "@/db/schema";
import { fastReelMatch, fastReelStart } from "@/lib/domain/fastReelStart";
import { namesUpload, progressOf, readReelReport, reelStateOf, signReelReport, signUploadTicket, setReelProgress, REPORT_TTL_MS } from "@/lib/domain/matchReel";
import { recordPlayedMatch } from "@/lib/domain/playedMatch";
import { questionOf } from "@/components/ReelNames";
import { createTestDb, makePlayer } from "./helpers/db";

// The route revalidates the match page; outside a request there is no page to revalidate.
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

// 24 November 2026, 18:00 in Bangkok; the matches were at 09:30 and 11:00 that morning.
const NOW = new Date("2026-11-24T11:00:00Z");
const KEYS = { priv: "8e634fbeffa64d5c4fcbdaa76e1aadaa388eeaa636cd8179f0d858311c321ab7", pub: "041adb0508a2d16a6e97203251a2a85ce6e30c2fa2ec6498fc1ddec242265447" };
const HOST = "https://reels.example.test";
const UPLOAD = "u".repeat(32);

async function four(tag: string) {
  return Promise.all(["Ana", "Bo", "Cy", "Di"].map((n) => makePlayer(db, `${n} ${tag}`)));
}
const code = async (m: { code: string }) => (await db.select().from(events).where(eq(events.code, m.code)))[0];

describe("the report key of the fast reel's job", () => {
  it("opens the codes it was signed for, until its time, and no others", async () => {
    const key = await signReelReport(["AB12", "CD34", "../x"], KEYS, NOW);
    expect(await readReelReport(key, KEYS.pub, NOW)).toEqual(["AB12", "CD34"]);
    expect(await readReelReport(key, KEYS.pub, new Date(NOW.getTime() + REPORT_TTL_MS + 1000))).toBeNull();
    // An upload ticket is not a report key, and a changed key is nothing.
    expect(await readReelReport(await signUploadTicket(UPLOAD, KEYS, NOW), KEYS.pub, NOW)).toBeNull();
    expect(await readReelReport(key.replace(/^./, (c) => (c === "e" ? "f" : "e")), KEYS.pub, NOW)).toBeNull();
  });
});

describe("the start of a fast reel", () => {
  it("names the pairs by first names, the score, and the other match of the same people that morning, first the uploaded one", async () => {
    const [ana, bo, cy, di] = await four("start");
    const first = await recordPlayedMatch(db, { startsAt: new Date("2026-11-24T02:30:00Z"), tz: "Asia/Bangkok", durationMinutes: 90, teamA: [ana.id, bo.id], teamB: [cy.id, di.id], sets: [{ sideA: 6, sideB: 3 }, { sideA: 6, sideB: 2 }], now: NOW });
    // The third set as a match of its own, with other pairs.
    const second = await recordPlayedMatch(db, { startsAt: new Date("2026-11-24T04:00:00Z"), tz: "Asia/Bangkok", durationMinutes: 60, teamA: [ana.id, cy.id], teamB: [bo.id, di.id], sets: [{ sideA: 5, sideB: 4 }], now: NOW });
    // Two of the four the next day: not this booking.
    const [x, y] = await four("other");
    await recordPlayedMatch(db, { startsAt: new Date("2026-11-24T05:00:00Z"), tz: "Asia/Bangkok", durationMinutes: 60, teamA: [ana.id, x.id], teamB: [bo.id, y.id], sets: [{ sideA: 6, sideB: 1 }], now: NOW });

    const start = await fastReelStart(db, second.code, KEYS, NOW);
    expect(start?.matches.map((m) => m.code)).toEqual([second.code, first.code]);
    expect(start?.matches[0]).toMatchObject({ title_a: "Ana & Cy", title_b: "Bo & Di", score: "5-4" });
    expect(start?.matches[1]).toMatchObject({ title_a: "Ana & Bo", title_b: "Cy & Di", score: "6-3 6-2" });
    expect(start?.matches[1].players).toEqual([
      { id: ana.id, name: "Ana", team: 1 },
      { id: bo.id, name: "Bo", team: 1 },
      { id: cy.id, name: "Cy", team: 2 },
      { id: di.id, name: "Di", team: 2 },
    ]);
    expect(await readReelReport(start?.report, KEYS.pub, NOW)).toEqual([second.code, first.code]);
  });

  it("makes no start for a match without two pairs of two", () => {
    expect(fastReelMatch("AB12", [{ eventId: "e", playerId: "p", team: "a", name: "Ana" }], [])).toBeNull();
  });
});

describe("who is who", () => {
  it("shows a bar on the second match too, and the names question to its players alone", async () => {
    const [ana, bo, cy, di] = await four("names");
    const m = await recordPlayedMatch(db, { startsAt: new Date("2026-11-24T02:30:00Z"), tz: "Asia/Bangkok", durationMinutes: 90, teamA: [ana.id, bo.id], teamB: [cy.id, di.id], sets: [{ sideA: 6, sideB: 3 }], now: NOW });
    const ev = await code(m);
    // No row yet: the first report makes one, so the page shows the bar.
    await setReelProgress(db, { code: m.code, pct: 30, minutesLeft: 0, step: "players", waiting: "names", host: HOST, upload: UPLOAD, now: NOW });
    const [row] = await db.select().from(matchReels).where(eq(matchReels.eventId, ev.id));
    expect(row.status).toBe("working");
    expect(progressOf(row.note)?.names).toEqual({ host: HOST, upload: UPLOAD });
    const state = reelStateOf(row, NOW);
    expect(state.kind === "working" && state.progress.names?.upload).toBe(UPLOAD);

    expect(await namesUpload(db, { eventId: ev.id, playerId: di.id })).toEqual({ upload: UPLOAD, code: m.code });
    const stranger = await makePlayer(db, "Stranger names");
    await expect(namesUpload(db, { eventId: ev.id, playerId: stranger.id })).rejects.toMatchObject({ code: "forbidden" });

    // The job goes on: the question is gone.
    await setReelProgress(db, { code: m.code, pct: 50, minutesLeft: 9, step: "follow", now: NOW });
    expect(await namesUpload(db, { eventId: ev.id, playerId: di.id })).toBeNull();
    // A host that is not one, or an upload that is not a token, asks nothing.
    await setReelProgress(db, { code: m.code, pct: 30, minutesLeft: 0, waiting: "names", host: "http://x", upload: UPLOAD, now: NOW });
    expect(await namesUpload(db, { eventId: ev.id, playerId: di.id })).toBeNull();
  });

  it("reads only a sane question from the reel host", () => {
    const q = questionOf({ players: [{ id: "p1", name: "Ana" }, { id: 5 }], tracks: [{ track: 0, face: "face-0.jpg", guess: "p1", ask: false }, { track: 1, face: "../x.jpg", guess: "p1" }, { track: 2, face: "face-2.jpg", guess: "nobody" }] });
    expect(q).toEqual({ players: [{ id: "p1", name: "Ana" }], tracks: [{ track: 0, face: "face-0.jpg", guess: "p1", ask: false }, { track: 2, face: "face-2.jpg", guess: null, ask: true }] });
    expect(questionOf("nonsense")).toBeNull();
  });
});

describe("the reel route with a report key", () => {
  it("takes the progress of the codes the key names, and nothing for another code or the delete", async () => {
    const { POST, DELETE } = await import("@/app/api/admin/match-reel/route");
    process.env.PASSPORT_PRIVATE_KEY = KEYS.priv;
    process.env.PASSPORT_PUBLIC_KEY = KEYS.pub;
    // The route reads the app's own database (no DATABASE_URL in the tests: a test database of its own).
    const app = await (await import("@/db")).getDb();
    const people = (tag: string) => Promise.all(["Ana", "Bo", "Cy", "Di"].map((n) => makePlayer(app, `${n} ${tag}`)));
    const [ana, bo, cy, di] = await people("route");
    const mine = await recordPlayedMatch(app, { startsAt: new Date(Date.now() - 3 * 3600_000), tz: "Asia/Bangkok", durationMinutes: 90, teamA: [ana.id, bo.id], teamB: [cy.id, di.id], sets: [{ sideA: 6, sideB: 3 }], now: new Date() });
    const [e, f, g, h] = await people("route other");
    const theirs = await recordPlayedMatch(app, { startsAt: new Date(Date.now() - 3 * 3600_000), tz: "Asia/Bangkok", durationMinutes: 90, teamA: [e.id, f.id], teamB: [g.id, h.id], sets: [{ sideA: 6, sideB: 3 }], now: new Date() });
    const key = await signReelReport([mine.code], KEYS, new Date());
    const call = (fn: (req: Request) => Promise<Response>, body: unknown) => fn(new Request("http://test/api/admin/match-reel", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await call(POST, { code: mine.code, progress: { pct: 10, minutesLeft: 20, step: "clips" } })).status).toBe(200);
    expect((await call(POST, { code: theirs.code, progress: { pct: 10, minutesLeft: 20, step: "clips" } })).status).toBe(401);
    expect((await call(DELETE, { code: mine.code })).status).toBe(401);
  });
});
