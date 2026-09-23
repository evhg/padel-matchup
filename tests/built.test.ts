import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { eventPhotos, events, feedback, slots } from "@/db/schema";
import { appendFeedbackReply, cleanPublicName, cleanPublicSummary, createFeedback, decideFeedback, feedbackWeek, listBuilt, setBuiltLine } from "@/lib/feedback/store";
import { lastMatchPhoto, photoByCode } from "@/lib/domain/photos";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * Two things Erik and the owner asked for on 23 September 2026.
 *
 * The page of ideas that became the app (/built) shows one line per shipped note, written by whoever
 * shipped it: never the note's own words (a note can be crude, a joke or malicious, and it was written
 * to us, not for a page). Beside it, the first name of the player who asked (the owner, later the same
 * day), taken from their name on Kicksmash, never from what the note typed.
 *
 * The first page's card draws the court photo of the viewer's last match behind it.
 */

const at = (day: number, hour = 12) => new Date(Date.UTC(2026, 8, day, hour));

describe("the page of ideas that became the app", () => {
  it("lists shipped notes by their summary and the asker's first name, newest first, and nothing a note wrote", async () => {
    const { db } = await createTestDb();
    const erik = await makePlayer(db, "Erik van Dam");
    const henk = await makePlayer(db, "dikke henk");
    const a = await createFeedback(db, { source: "web", text: "your app is rubbish, add a dark mode", name: "Troll" });
    const b = await createFeedback(db, { source: "web", text: "the QR is way too big", name: "Eriik", playerId: erik.id });
    const c = await createFeedback(db, { source: "web", text: "shipped but nobody wrote a line yet", name: "Ana" });
    const d = await createFeedback(db, { source: "web", text: "declined idea", name: "Bo", playerId: erik.id });
    const e = await createFeedback(db, { source: "web", text: "a test note", name: "dikke henk", playerId: henk.id });
    await decideFeedback(db, a.id, { status: "shipped", publicSummary: "Match pages follow the phone's dark mode." }, at(20));
    await decideFeedback(db, b.id, { status: "shipped", publicSummary: "The QR code on a new match folds away until you ask for it." }, at(22));
    await decideFeedback(db, c.id, { status: "shipped" }, at(21));
    await decideFeedback(db, d.id, { status: "declined", publicSummary: "Not on the page: it did not ship." }, at(21));
    // A test user: the desk hides the name with an empty string.
    await decideFeedback(db, e.id, { status: "shipped", publicSummary: "The score prompt closes itself once the score is in.", publicName: "" }, at(19));

    const built = await listBuilt(db);
    expect(built.map((x) => [x.summary, x.name])).toEqual([
      ["The QR code on a new match folds away until you ask for it.", "Erik"],
      ["Match pages follow the phone's dark mode.", null],
      ["The score prompt closes itself once the score is in.", null],
    ]);
    const page = JSON.stringify(built);
    // The note's words and the name the note typed never reach the page; only the name on Kicksmash.
    for (const words of ["rubbish", "Troll", "Eriik", "van Dam", "too big", "nobody wrote", "dikke", "Dikke"]) expect(page).not.toContain(words);

    // A reply reopens a shipped note for another look; until it is decided again, the page and the
    // card's count agree that it is not counted as shipped.
    await appendFeedbackReply(db, b.id, "thanks, but it is still big on my phone", at(23));
    expect((await listBuilt(db)).map((x) => x.summary)).toEqual(["Match pages follow the phone's dark mode.", "The score prompt closes itself once the score is in."]);
  });

  it("takes a summary for a note already shipped, without moving its date", async () => {
    const { db } = await createTestDb();
    const n = await createFeedback(db, { source: "web", text: "restore does not work here", name: "Erik" });
    await decideFeedback(db, n.id, { status: "shipped" }, at(22));
    expect(await listBuilt(db)).toEqual([]);
    await setBuiltLine(db, n.id, { summary: "The way back in works on the landing page too." });
    const [row] = await db.select().from(feedback).where(eq(feedback.id, n.id));
    expect(row.shippedAt?.toISOString()).toBe(at(22).toISOString());
    expect((await listBuilt(db)).map((x) => x.summary)).toEqual(["The way back in works on the landing page too."]);
    // A name for a note shipped before names were shown, and back to none; the summary stays.
    await setBuiltLine(db, n.id, { name: "Erik" });
    expect((await listBuilt(db))[0]).toMatchObject({ summary: "The way back in works on the landing page too.", name: "Erik" });
    await setBuiltLine(db, n.id, { name: "" });
    expect((await listBuilt(db))[0]).toMatchObject({ summary: "The way back in works on the landing page too.", name: null });
    // Only a shipped note can be on the page.
    const open = await createFeedback(db, { source: "web", text: "still open", name: "Ana" });
    expect(await setBuiltLine(db, open.id, { summary: "Not shipped, so not here." })).toBeNull();
  });

  it("keeps a summary to one plain line", () => {
    expect(cleanPublicSummary("  Match <b>pages</b>\n follow   dark mode. ")).toBe("Match pages follow dark mode.");
    expect(cleanPublicSummary("ok")).toBeNull();
    expect(cleanPublicSummary("x".repeat(500))).toHaveLength(200);
  });

  it("keeps a name to one first name, letters only", () => {
    expect(cleanPublicName("  erik van Dam ")).toBe("Erik");
    expect(cleanPublicName("Анна-Мария")).toBe("Анна-Мария");
    expect(cleanPublicName("<b>José</b>")).toBe("José");
    expect(cleanPublicName("J")).toBeNull();
    expect(cleanPublicName("🎾🎾")).toBeNull();
    expect(cleanPublicName("")).toBeNull();
  });

  it("counts an answered question as answered, not as an idea turned down", async () => {
    const { db } = await createTestDb();
    const q = await createFeedback(db, { source: "web", text: "does saving my email merge?", name: "Erik" });
    const idea = await createFeedback(db, { source: "web", text: "add a bracket editor", name: "Bo" });
    await decideFeedback(db, q.id, { status: "declined", verdict: "answered" }, at(22));
    await decideFeedback(db, idea.id, { status: "declined", verdict: "decline" }, at(22));
    // The week counts a decision by when its message went out; neither note has a channel here.
    await db.update(feedback).set({ repliedAt: at(22) });
    expect((await feedbackWeek(db, at(20))).declined).toBe(1);
  });
});

describe("the photo of the last match, behind the card being typed", () => {
  it("finds the latest match with a photo that this person played or organised", async () => {
    const { db } = await createTestDb();
    const ana = await makePlayer(db, "Ana");
    const bo = await makePlayer(db, "Bo");
    const stranger = await makePlayer(db, "Cy");
    const mk = async (code: string, day: number, creator: string) =>
      (await db.insert(events).values({ code, manageCode: `${code}mng999`, title: code, startsAt: at(day), tz: "Asia/Bangkok", capacity: 4, creatorPlayerId: creator } as never).returning())[0];
    const older = await mk("OLD1", 10, ana.id);
    const newer = await mk("NEW1", 15, bo.id);
    await db.insert(slots).values({ eventId: newer.id, position: 1, playerId: ana.id, status: "joined", kind: "open" } as never);
    await db.insert(eventPhotos).values({ eventId: older.id, uploadedByPlayerId: ana.id, mime: "image/png", dataBase64: "iVBORw0KGgo=", createdAt: at(10, 14) });
    expect((await lastMatchPhoto(db, ana.id))?.code).toBe("OLD1");
    await db.insert(eventPhotos).values({ eventId: newer.id, uploadedByPlayerId: bo.id, mime: "image/png", dataBase64: "iVBORw0KGgo=", createdAt: at(15, 14) });
    const latest = await lastMatchPhoto(db, ana.id);
    expect(latest).toEqual({ code: "NEW1", version: at(15, 14).getTime() });
    expect(await lastMatchPhoto(db, stranger.id)).toBeNull();
    expect((await photoByCode(db, "NEW1"))?.mime).toBe("image/png");
    expect(await photoByCode(db, "NONE")).toBeNull();
  });
});
