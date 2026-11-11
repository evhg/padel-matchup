import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { highlightsLinkOf, removeHighlights, setHighlights } from "@/lib/domain/highlights";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const WATCH = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

describe("the highlights link, from what was pasted", () => {
  it("takes every YouTube spelling and keeps one", () => {
    for (const s of [
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=abc123",
      "youtu.be/dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
      "Our match on Friday! https://youtu.be/dQw4w9WgXcQ see you next week",
    ])
      expect(highlightsLinkOf(s), s).toBe(WATCH);
  });

  it("refuses anything that is not a YouTube video", () => {
    for (const s of ["", "   ", "great match", "https://vimeo.com/123456", "https://evil.example/watch?v=dQw4w9WgXcQ", "https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ", "https://www.youtube.com/watch?v=short", "https://www.youtube.com/@kicksmash", "javascript:alert(1)//youtu.be/dQw4w9WgXcQ"])
      expect(highlightsLinkOf(s), s).toBeNull();
  });
});

describe("who adds and who removes the link", () => {
  it("anybody in the match after the start; the adder or the organiser removes it", async () => {
    const org = await makePlayer(db, "Org");
    const mate = await makePlayer(db, "Mate");
    const other = await makePlayer(db, "Other");
    const stranger = await makePlayer(db, "Stranger");
    const e = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", whenFull: "closed" });
    await joinEvent(db, { eventId: e.id, playerId: mate.id });
    await joinEvent(db, { eventId: e.id, playerId: other.id });

    await expect(setHighlights(db, { eventId: e.id, playerId: mate.id, text: WATCH })).rejects.toMatchObject({ code: "not_started" });
    await db.update(events).set({ startsAt: new Date(Date.now() - HOUR) }).where(eq(events.id, e.id));

    await expect(setHighlights(db, { eventId: e.id, playerId: stranger.id, text: WATCH })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setHighlights(db, { eventId: e.id, playerId: mate.id, text: "no link here" })).rejects.toMatchObject({ code: "invalid" });
    expect(await setHighlights(db, { eventId: e.id, playerId: mate.id, text: "https://youtu.be/dQw4w9WgXcQ" })).toBe(WATCH);

    const [row] = await db.select({ url: events.highlightsUrl, by: events.highlightsBy }).from(events).where(eq(events.id, e.id));
    expect(row).toEqual({ url: WATCH, by: mate.id });

    await expect(removeHighlights(db, e.id, other.id)).rejects.toMatchObject({ code: "forbidden" });
    await removeHighlights(db, e.id, org.id);
    const [gone] = await db.select({ url: events.highlightsUrl, by: events.highlightsBy }).from(events).where(eq(events.id, e.id));
    expect(gone).toEqual({ url: null, by: null });

    // The organiser adds it too, and the adder takes their own down.
    await setHighlights(db, { eventId: e.id, playerId: org.id, text: WATCH });
    await removeHighlights(db, e.id, org.id);
  });
});
