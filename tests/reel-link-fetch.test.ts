import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, matchReels } from "@/db/schema";
import { LINK_START_MINUTES, driveFileOf, progressOf, reelFetchFailed, reelStateOf, reelUploadReceived, setReelFetch, setReelLink, signUploadTicket } from "@/lib/domain/matchReel";
import { recordPlayedMatch } from "@/lib/domain/playedMatch";
import { makePlayer } from "./helpers/db";

// The route revalidates the match page; outside a request there is no page to revalidate.
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

// The owner, 27 November 2026: a player pasted a Drive link and the page only said "The video is here". "Improve that.
// Remaining minutes and progress bar." A Drive file now goes the way of an upload: the reel host fetches it, the bar
// shows from the first minute, and the job starts by itself when the film is on the store.
const KEYS = { priv: "8e634fbeffa64d5c4fcbdaa76e1aadaa388eeaa636cd8179f0d858311c321ab7", pub: "041adb0508a2d16a6e97203251a2a85ce6e30c2fa2ec6498fc1ddec242265447" };
const FILE = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const LINK = `https://drive.google.com/file/d/${FILE}/view?usp=drivesdk`;

let db: Db;
beforeAll(async () => {
  process.env.PASSPORT_PRIVATE_KEY = KEYS.priv;
  process.env.PASSPORT_PUBLIC_KEY = KEYS.pub;
  db = await (await import("@/db")).getDb();
});
afterAll(() => undefined);

async function played(tag: string) {
  const now = new Date();
  const [ana, bo, cy, di] = await Promise.all(["Ana", "Bo", "Cy", "Di"].map((n) => makePlayer(db, `${n} ${tag}`)));
  const m = await recordPlayedMatch(db, { startsAt: new Date(now.getTime() - 3 * 3600_000), tz: "Asia/Bangkok", durationMinutes: 90, teamA: [ana.id, bo.id], teamB: [cy.id, di.id], sets: [{ sideA: 6, sideB: 3 }], now });
  const [ev] = await db.select().from(events).where(eq(events.code, m.code));
  return { ev, ana, bo };
}
const rowOf = async (eventId: string) => (await db.select().from(matchReels).where(eq(matchReels.eventId, eventId)))[0];
const post = async (body: unknown) => {
  const { POST } = await import("@/app/api/reel/fetch/route");
  return POST(new Request("http://test/api/reel/fetch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
};

describe("the Drive file of a link", () => {
  it("reads the file of a shared link, and nothing from a folder or another drive", () => {
    expect(driveFileOf(LINK)).toBe(FILE);
    expect(driveFileOf(`https://drive.google.com/open?id=${FILE}`)).toBe(FILE);
    expect(driveFileOf(`https://docs.google.com/uc?id=${FILE}&export=download`)).toBe(FILE);
    expect(driveFileOf(`https://drive.google.com/drive/folders/${FILE}`)).toBeNull();
    expect(driveFileOf(`https://www.dropbox.com/s/${FILE}/match.mov`)).toBeNull();
    expect(driveFileOf("https://drive.google.com/file/d/short/view")).toBeNull();
    expect(driveFileOf(`http://drive.google.com/file/d/${FILE}/view`)).toBeNull();
    expect(driveFileOf(null)).toBeNull();
  });
});

describe("a Drive link the reel host fetches", () => {
  it("shows the bar from the first minute, then starts as an upload does", async () => {
    const { ev, ana, bo } = await played("link fetch");
    const now = new Date();
    const got = await setReelLink(db, { eventId: ev.id, playerId: ana.id, text: `Here it is ${LINK}`, fetch: true, now });
    expect(got.fetch?.file).toBe(FILE);
    const row = await rowOf(ev.id);
    expect(row).toMatchObject({ status: "asked", source: "upload", sourceUrl: LINK, reelToken: got.fetch?.token });
    // The page shows the bar and the minutes at once, never "The video is here" with nothing behind it.
    const state = reelStateOf(row, now);
    expect(state.kind).toBe("working");
    if (state.kind === "working") {
      expect(state.progress).toMatchObject({ pct: 0, step: "fetch", names: null });
      expect((state.progress.readyBy.getTime() - now.getTime()) / 60_000).toBe(LINK_START_MINUTES);
    }
    // A second player's link does not throw away the film on its way.
    await expect(setReelLink(db, { eventId: ev.id, playerId: bo.id, text: LINK, fetch: true, now })).rejects.toMatchObject({ code: "locked" });

    // The reel host's report: no ticket, nothing; with the ticket, the share done and the minutes to the reel.
    expect((await post({ pct: 50, minutesLeft: 5 })).status).toBe(401);
    const ticket = await signUploadTicket(got.fetch!.token, KEYS, new Date());
    expect((await post({ ticket, pct: 50, minutesLeft: -1 })).status).toBe(400);
    expect(await (await post({ ticket, pct: 50, minutesLeft: 5 })).json()).toEqual({ ok: true, changed: true });
    const half = progressOf((await rowOf(ev.id)).note)!;
    expect(half).toMatchObject({ pct: 50, step: "fetch" });
    // Five minutes of the fetch, then the job's thirty.
    const minutes = (half.readyBy.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(34);
    expect(minutes).toBeLessThanOrEqual(35);

    // The film is here: the same door as an upload, so the job starts by itself; a late report then changes nothing.
    expect(await reelUploadReceived(db, got.fetch!.token)).toEqual({ code: ev.code, way: "upload" });
    expect(await setReelFetch(db, got.fetch!.token, { pct: 99, minutesLeft: 1 })).toBeNull();
    expect(await reelFetchFailed(db, got.fetch!.token)).toBeNull();
  });

  it("says what to fix when the link gives no film", async () => {
    const { ev, ana } = await played("link failed");
    const got = await setReelLink(db, { eventId: ev.id, playerId: ana.id, text: LINK, fetch: true });
    const ticket = await signUploadTicket(got.fetch!.token, KEYS, new Date());
    expect(await (await post({ ticket, failed: true })).json()).toEqual({ ok: true, changed: true });
    const row = await rowOf(ev.id);
    expect(row.status).toBe("failed");
    expect(reelStateOf(row, new Date())).toEqual({ kind: "none", failed: true, linkFailed: true });
    // The player can send the link again at once.
    const again = await setReelLink(db, { eventId: ev.id, playerId: ana.id, text: LINK, fetch: true });
    expect(again.fetch?.token).not.toBe(got.fetch!.token);
  });

  it("keeps every other link as before: the video is here, for a person", async () => {
    const { ev, ana } = await played("link other");
    const dropbox = await setReelLink(db, { eventId: ev.id, playerId: ana.id, text: "https://www.dropbox.com/s/abc/match.mov", fetch: true });
    expect(dropbox.fetch).toBeNull();
    const row = await rowOf(ev.id);
    expect(row).toMatchObject({ status: "received", source: "link", note: null });
    expect(reelStateOf(row, new Date())).toEqual({ kind: "here", source: "link" });

    // With the reel host off, a Drive link too.
    const other = await played("link host off");
    expect((await setReelLink(db, { eventId: other.ev.id, playerId: other.ana.id, text: LINK })).fetch).toBeNull();
    expect((await rowOf(other.ev.id)).status).toBe("received");
  });
});
