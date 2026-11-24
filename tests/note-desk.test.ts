import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { feedback } from "@/db/schema";
import { createFeedback } from "@/lib/feedback/store";
import { DESK, wakeForOpenNotes, wakeNoteDesk } from "@/lib/feedback/desk";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const URL_OK = "https://api.anthropic.com/v1/claude_code/routines/trig_01TESTTESTTEST/fire";
const env = { url: process.env.NOTE_DESK_FIRE_URL, token: process.env.NOTE_DESK_TOKEN };
afterEach(() => {
  process.env.NOTE_DESK_FIRE_URL = env.url;
  process.env.NOTE_DESK_TOKEN = env.token;
  if (env.url === undefined) delete process.env.NOTE_DESK_FIRE_URL;
  if (env.token === undefined) delete process.env.NOTE_DESK_TOKEN;
});

const T0 = new Date("2026-11-24T06:00:00Z");
const fake = (status = 200) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ type: "routine_fire" }), { status });
  }) as unknown as typeof fetch;
  return { f, calls };
};

describe("the note desk", () => {
  it("stays off without its URL and token, and with a URL that is not a routine's", async () => {
    const { f, calls } = fake();
    delete process.env.NOTE_DESK_FIRE_URL;
    process.env.NOTE_DESK_TOKEN = "t";
    expect(await wakeNoteDesk(db, "a note", f, T0)).toBe("off");
    process.env.NOTE_DESK_FIRE_URL = "https://example.com/fire";
    expect(await wakeNoteDesk(db, "a note", f, T0)).toBe("off");
    expect(calls).toHaveLength(0);
  });

  it("wakes once for a burst of notes, with the token and the beta header, and again after the gap", async () => {
    process.env.NOTE_DESK_FIRE_URL = URL_OK;
    process.env.NOTE_DESK_TOKEN = "tok";
    const { f, calls } = fake();
    expect(await wakeNoteDesk(db, "a new note (web)", f, T0)).toBe("woken");
    expect(await wakeNoteDesk(db, "a new note (web)", f, new Date(T0.getTime() + 60_000))).toBe("recent");
    expect(calls).toHaveLength(1);
    const h = calls[0].init.headers as Record<string, string>;
    expect([calls[0].url, h.Authorization, h["anthropic-beta"]]).toEqual([URL_OK, "Bearer tok", "experimental-cc-routine-2026-04-01"]);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ text: "Kicksmash: a new note (web)" });
    expect(await wakeNoteDesk(db, "later", f, new Date(T0.getTime() + DESK.gapMs + 1000))).toBe("woken");
  });

  it("gives the claim back when the wake fails, so the hourly job tries again", async () => {
    process.env.NOTE_DESK_FIRE_URL = URL_OK;
    process.env.NOTE_DESK_TOKEN = "tok";
    const t = new Date(T0.getTime() + DAY_MS);
    expect(await wakeNoteDesk(db, "x", fake(503).f, t)).toBe("failed");
    expect(await wakeNoteDesk(db, "x", fake().f, new Date(t.getTime() + 1000))).toBe("woken");
  });

  it("the hourly job wakes it only while a note is still open", async () => {
    process.env.NOTE_DESK_FIRE_URL = URL_OK;
    process.env.NOTE_DESK_TOKEN = "tok";
    const t = new Date(T0.getTime() + 2 * DAY_MS);
    await db.delete(feedback);
    expect(await wakeForOpenNotes(db, fake().f, t)).toBe("none");
    const note = await createFeedback(db, { source: "web", text: "The score form does not save" }, new Date(t.getTime() - 30 * 60_000));
    await db.update(feedback).set({ status: "acknowledged" }).where(eq(feedback.id, note.id));
    const { f, calls } = fake();
    expect(await wakeForOpenNotes(db, f, t)).toBe("woken");
    expect(JSON.parse(String(calls[0].init.body)).text).toBe("Kicksmash: 1 note(s) still open");
    await db.update(feedback).set({ status: "shipped" }).where(eq(feedback.id, note.id));
    expect(await wakeForOpenNotes(db, f, new Date(t.getTime() + 2 * DESK.gapMs))).toBe("none");
  });
});

const DAY_MS = 86_400_000;
