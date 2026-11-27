import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { matchReels } from "@/db/schema";
import { readFileSync } from "node:fs";
import { events, slots } from "@/db/schema";
import {
  REEL_KEEP_DAYS,
  TICKET_PREFIX,
  TICKET_TTL_MS,
  UPLOAD_MAX_BYTES,
  VIDEO_KEEP_DAYS,
  askReelUpload,
  isReelToken,
  matchReel,
  readUploadTicket,
  reelHostOf,
  reelState,
  reelStateOf,
  reelUploadReceived,
  reelView,
  removeMatchReel,
  setMatchReel,
  setReelLink,
  signUploadTicket,
  videoLinkOf,
} from "@/lib/domain/matchReel";
import { fromBase64Url } from "@/lib/domain/passport";
import { recordPlayedMatch } from "@/lib/domain/playedMatch";
import { createTestDb, makePlayer, DAY } from "./helpers/db";

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
      share: `${HOST}/r/${TOKEN}/share.mp4`,
      saveTall: `${HOST}/r/${TOKEN}/tall.mp4?dl=1`,
      saveWide: `${HOST}/r/${TOKEN}/wide.mp4?dl=1`,
      poster: `${HOST}/r/${TOKEN}/poster.jpg`,
      keptUntil: new Date(NOW.getTime() + 30 * DAY),
      noScore: null,
    });
    // A reel from the whole film with no score keeps why in its note, and the page reads only a reason it knows.
    expect(reelView({ ...row, note: JSON.stringify({ noScore: "no_winners" }) }, NOW)?.noScore).toBe("no_winners");
    for (const note of [JSON.stringify({ noScore: "anything" }), JSON.stringify({ pct: 40, readyBy: NOW.toISOString() }), "not json", "null", null]) expect(reelView({ ...row, note }, NOW)?.noScore, String(note)).toBeNull();
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

// The pair of e2e/run.mjs: for tests only.
const KEYS = { priv: "8e634fbeffa64d5c4fcbdaa76e1aadaa388eeaa636cd8179f0d858311c321ab7", pub: "041adb0508a2d16a6e97203251a2a85ce6e30c2fa2ec6498fc1ddec242265447" };
const OTHER_PUB = "56fceb94b16ee67d2c51c8cccd3f32f700e6ef95adab516edf52b7be8d03c697";

describe("the ticket of an upload", () => {
  it("names the upload, its end and its size, and reads back only while it is ours, whole and in time", async () => {
    const ticket = await signUploadTicket(TOKEN, KEYS, NOW);
    const [body, sig, more] = ticket.split(".");
    expect(more).toBeUndefined();
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(body)))).toEqual({ exp: Math.floor((NOW.getTime() + TICKET_TTL_MS) / 1000), max: UPLOAD_MAX_BYTES, p: "reel-upload", t: TOKEN });
    expect(fromBase64Url(sig).length).toBe(64);

    expect(await readUploadTicket(ticket, KEYS.pub, NOW)).toBe(TOKEN);
    expect(await readUploadTicket(ticket, KEYS.pub, new Date(NOW.getTime() + TICKET_TTL_MS - 1000))).toBe(TOKEN);
    expect(await readUploadTicket(ticket, KEYS.pub, new Date(NOW.getTime() + TICKET_TTL_MS + 1000))).toBeNull();
    expect(await readUploadTicket(ticket, OTHER_PUB, NOW)).toBeNull();
    expect(await readUploadTicket(`${body.slice(0, -2)}AA.${sig}`, KEYS.pub, NOW)).toBeNull();
    for (const bad of ["", "one-part", `${ticket}.more`, null, 7]) expect(await readUploadTicket(bad, KEYS.pub, NOW), String(bad)).toBeNull();
  });

  it("is the ticket the reel host reads: the same words before the payload, the same days, the same size", () => {
    const host = readFileSync("scripts/highlights/modal/serve.py", "utf8");
    expect(host).toContain(`TICKET_PREFIX = '${TICKET_PREFIX}'`);
    expect(host).toContain(`KEEP_DAYS = {'reels': ${REEL_KEEP_DAYS}, 'uploads': ${VIDEO_KEEP_DAYS}}`);
    expect(host).toContain("UPLOAD_MAX = 80 << 30");
    expect(UPLOAD_MAX_BYTES).toBe(80 * 2 ** 30);
  });
});

describe("a link to the film", () => {
  it("keeps a shared link on a drive, from a bare link or from a share text", () => {
    expect(videoLinkOf("https://www.icloud.com/iclouddrive/0a1B2c3D4e#IMG_0042")).toBe("https://www.icloud.com/iclouddrive/0a1B2c3D4e#IMG_0042");
    expect(videoLinkOf("drive.google.com/file/d/1AbC/view?usp=sharing")).toBe("https://drive.google.com/file/d/1AbC/view?usp=sharing");
    expect(videoLinkOf("Our match! https://www.dropbox.com/scl/fi/abc/match.mov?dl=0 see you")).toBe("https://www.dropbox.com/scl/fi/abc/match.mov?dl=0");
    expect(videoLinkOf("https://1drv.ms/v/s!Abc")).toBe("https://1drv.ms/v/s!Abc");
  });

  it("refuses what is not a film on a drive", () => {
    for (const bad of ["", "   ", "https://example.com/video.mov", "http://drive.google.com/file/d/1AbC", "https://drive.google.com", "https://evil-icloud.com/x", "https://icloud.com.evil.example/x", "https://u:p@www.dropbox.com/x", "javascript:alert(1)", null, 7])
      expect(videoLinkOf(bad), String(bad)).toBeNull();
  });
});

describe("a player sends the match video", () => {
  const match = async (tag: string) => {
    const [ana, bo, cy, di] = [await makePlayer(db, `Ana ${tag}`), await makePlayer(db, `Bo ${tag}`), await makePlayer(db, `Cy ${tag}`), await makePlayer(db, `Di ${tag}`)];
    const { code } = await recordPlayedMatch(db, { startsAt: new Date(NOW.getTime() - 2 * DAY), tz: "Asia/Bangkok", venueName: `Send Club ${tag}`, teamA: [ana.id, bo.id], teamB: [cy.id, di.id], sets: [{ sideA: 6, sideB: 3 }, { sideA: 6, sideB: 2 }], now: NOW });
    const [ev] = await db.select().from(events).where(eq(events.code, code));
    return { ev, ana, bo, cy, di, stranger: await makePlayer(db, `Zed ${tag}`) };
  };
  const row = async (eventId: string) => (await db.select().from(matchReels).where(eq(matchReels.eventId, eventId)))[0];

  it("gives one upload to a match: the same token to each of its players until the film is here, and nothing to a stranger", async () => {
    const { ev, ana, cy, stranger } = await match("up");
    expect(await reelState(db, ev.id, NOW)).toEqual({ kind: "none", failed: false });
    const first = await askReelUpload(db, { eventId: ev.id, playerId: cy.id, now: NOW });
    expect(isReelToken(first.token) && first.token.length === 32).toBe(true);
    expect(first.code).toBe(ev.code);
    expect(await row(ev.id)).toMatchObject({ status: "asked", source: "upload", requestedBy: cy.id, host: null, readyAt: null });
    expect(await reelState(db, ev.id, NOW)).toEqual({ kind: "sending" });
    // Another player of the match goes on with the same upload.
    expect((await askReelUpload(db, { eventId: ev.id, playerId: ana.id, now: NOW })).token).toBe(first.token);
    await expect(askReelUpload(db, { eventId: ev.id, playerId: stranger.id, now: NOW })).rejects.toMatchObject({ code: "forbidden" });

    // The reel host's word, once: the film is here.
    expect(await reelUploadReceived(db, "a_token_nobody_asked_for_x")).toBeNull();
    expect(await reelUploadReceived(db, first.token)).toEqual({ code: ev.code, way: "upload" });
    expect(await reelUploadReceived(db, first.token)).toBeNull();
    expect(await reelState(db, ev.id, NOW)).toEqual({ kind: "here", source: "upload" });
    // A film that is here is not written over by a second upload or a link.
    await expect(askReelUpload(db, { eventId: ev.id, playerId: ana.id, now: NOW })).rejects.toMatchObject({ code: "locked" });
    await expect(setReelLink(db, { eventId: ev.id, playerId: ana.id, text: "https://www.icloud.com/iclouddrive/abc", now: NOW })).rejects.toMatchObject({ code: "locked" });

    // The operator's reel takes the row's place, and then nobody sends a second film while it plays.
    await setMatchReel(db, { code: ev.code, host: HOST, token: TOKEN, now: NOW });
    expect((await reelState(db, ev.id, NOW)).kind).toBe("ready");
    await expect(askReelUpload(db, { eventId: ev.id, playerId: ana.id, now: NOW })).rejects.toMatchObject({ code: "locked" });
    // Past its 30 days the page asks again, and a new upload gets a new token.
    const later = new Date(NOW.getTime() + 31 * DAY);
    expect(await reelState(db, ev.id, later)).toEqual({ kind: "none", failed: false });
    expect((await askReelUpload(db, { eventId: ev.id, playerId: ana.id, now: later })).token).not.toBe(TOKEN);
  });

  it("makes a new reel on purpose: a player of the match replaces the reel that plays, a stranger cannot, and a video that is here stays locked", async () => {
    const { ev, ana, stranger } = await match("again");
    await setMatchReel(db, { code: ev.code, host: HOST, token: TOKEN, now: NOW });
    expect((await reelState(db, ev.id, NOW)).kind).toBe("ready");
    // "Make a new reel" is the only door past a reel that plays, and only for the match's own people.
    await expect(askReelUpload(db, { eventId: ev.id, playerId: stranger.id, again: true, now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    const again = await askReelUpload(db, { eventId: ev.id, playerId: ana.id, way: "clips", again: true, now: NOW });
    expect(again.token).not.toBe(TOKEN);
    expect(await row(ev.id)).toMatchObject({ status: "asked", source: "clips", requestedBy: ana.id, host: null, readyAt: null });
    expect(await reelState(db, ev.id, NOW)).toEqual({ kind: "sending" });
    // Once the new film is here, nobody writes over it, not even on purpose.
    expect(await reelUploadReceived(db, again.token)).toEqual({ code: ev.code, way: "clips" });
    await expect(askReelUpload(db, { eventId: ev.id, playerId: ana.id, again: true, now: NOW })).rejects.toMatchObject({ code: "locked" });
    await expect(setReelLink(db, { eventId: ev.id, playerId: ana.id, text: "https://www.icloud.com/iclouddrive/abc", again: true, now: NOW })).rejects.toMatchObject({ code: "locked" });
  });

  it("keeps the two ways apart: the clips of a fast reel are another upload than the whole film", async () => {
    const { ev, ana, bo } = await match("ways");
    const whole = await askReelUpload(db, { eventId: ev.id, playerId: ana.id, now: NOW });
    const clips = await askReelUpload(db, { eventId: ev.id, playerId: bo.id, way: "clips", now: NOW });
    expect(clips.token).not.toBe(whole.token);
    expect(await row(ev.id)).toMatchObject({ status: "asked", source: "clips", requestedBy: bo.id });
    // The same way again goes on with the same upload; the first upload's ticket no longer names this match's row.
    expect((await askReelUpload(db, { eventId: ev.id, playerId: ana.id, way: "clips", now: NOW })).token).toBe(clips.token);
    expect(await reelUploadReceived(db, whole.token)).toBeNull();
    expect(await reelUploadReceived(db, clips.token)).toEqual({ code: ev.code, way: "clips" });
    expect(await reelState(db, ev.id, NOW)).toEqual({ kind: "here", source: "clips" });
  });

  it("keeps a link to the film, takes the place of an upload that never finished, and refuses a link that is not one", async () => {
    const { ev, ana, bo, stranger } = await match("link");
    await askReelUpload(db, { eventId: ev.id, playerId: ana.id, now: NOW });
    await expect(setReelLink(db, { eventId: ev.id, playerId: bo.id, text: "https://example.com/film.mov", now: NOW })).rejects.toMatchObject({ code: "invalid" });
    await expect(setReelLink(db, { eventId: ev.id, playerId: stranger.id, text: "https://www.icloud.com/iclouddrive/abc", now: NOW })).rejects.toMatchObject({ code: "forbidden" });
    expect((await row(ev.id)).status).toBe("asked");
    expect(await setReelLink(db, { eventId: ev.id, playerId: bo.id, text: "The film: https://www.icloud.com/iclouddrive/abc", now: NOW })).toEqual({ code: ev.code });
    expect(await row(ev.id)).toMatchObject({ status: "received", source: "link", sourceUrl: "https://www.icloud.com/iclouddrive/abc", requestedBy: bo.id });
    expect(await reelState(db, ev.id, NOW)).toEqual({ kind: "here", source: "link" });
  });

  it("asks nothing of a match that has not started or was cancelled, and shows a failed reel as a new chance", async () => {
    const { ev, ana } = await match("when");
    await expect(askReelUpload(db, { eventId: ev.id, playerId: ana.id, now: new Date(ev.startsAt.getTime() - 1000) })).rejects.toMatchObject({ code: "not_started" });
    await db.update(events).set({ status: "cancelled" }).where(eq(events.id, ev.id));
    await expect(askReelUpload(db, { eventId: ev.id, playerId: ana.id, now: NOW })).rejects.toMatchObject({ code: "cancelled" });
    expect(reelStateOf({ status: "failed", host: null, reelToken: TOKEN, readyAt: null, source: "upload" }, NOW)).toEqual({ kind: "none", failed: true });
    expect(reelStateOf({ status: "working", host: null, reelToken: TOKEN, readyAt: null, source: "link" }, NOW)).toEqual({ kind: "here", source: "link" });
    expect((await db.select({ id: slots.id }).from(slots).where(eq(slots.eventId, ev.id))).length).toBeGreaterThan(0);
  });
});

