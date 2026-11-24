import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, matchReels, metricsDaily } from "@/db/schema";
import { ackFromContent, composeAck } from "@/lib/feedback/ack";
import { pageFacts } from "@/lib/feedback/pageFacts";
import { formatProposal } from "@/lib/feedback/propose";
import { recordPlayedMatch } from "@/lib/domain/playedMatch";
import { createTestDb, makePlayer, DAY } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const saved = { key: process.env.ANTHROPIC_API_KEY, desk: process.env.NOTE_DESK_TOKEN, url: process.env.NOTE_DESK_FIRE_URL };
afterEach(() => {
  for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["NOTE_DESK_TOKEN", saved.desk], ["NOTE_DESK_FIRE_URL", saved.url]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// 24 November 2026, 15:14 in Bangkok: the hour a player asked "the video is here? I dont see it".
const NOW = new Date("2026-11-24T08:14:00Z");

describe("a note knows the page it came from", () => {
  it("says when and where the match was, who played on which side, the score, and where its reel is", async () => {
    const [ana, bo, cy] = [await makePlayer(db, "Ana"), await makePlayer(db, "Bo"), await makePlayer(db, "Cy")];
    const m = await recordPlayedMatch(db, { startsAt: new Date("2026-11-24T02:30:00Z"), tz: "Asia/Bangkok", durationMinutes: 90, venueName: "Page Club", teamA: [ana.id, bo.id], teamB: [cy.id, "Di"], sets: [{ sideA: 6, sideB: 3 }, { sideA: 6, sideB: 2 }], now: NOW });
    const [ev] = await db.select().from(events).where(eq(events.code, m.code));
    await db.insert(matchReels).values({ eventId: ev.id, status: "received", reelToken: "t".repeat(30), source: "clips", createdAt: new Date("2026-11-24T05:30:00Z") });
    const facts = (await pageFacts(db, `/${m.code}`, NOW)) ?? "";
    expect(facts).toContain(`match ${m.code}: Tue 24 Nov, 09:30, 90 minutes, at Page Club; times are in Asia/Bangkok, now 15:14.`);
    expect(facts).toContain("Players: Ana and Bo against Cy and Di.");
    expect(facts).toContain("Score: 6-3 6-2, confirmed by the organiser");
    expect(facts).toContain("Reel: the clips of a fast reel arrived (sending began at 12:30). The reel is made from it on the reel host and is not ready yet.");
    expect(await pageFacts(db, "/clubs", NOW)).toBeNull();
    expect(await pageFacts(db, null, NOW)).toBeNull();
  });
});

describe("the instant reply", () => {
  it("reads the model's answer from the reply tool, and from text as before", () => {
    expect(ackFromContent([{ type: "tool_use", name: "reply", input: { kind: "feedback", reply: 'Your clips arrived at 12:30, and the reel is not "made" yet.' } }])).toEqual({ kind: "feedback", reply: 'Your clips arrived at 12:30, and the reel is not "made" yet.' });
    expect(ackFromContent([{ type: "text", text: '{"kind":"not_feedback","reply":"Tell me what should change."}' }])).toEqual({ kind: "not_feedback", reply: "Tell me what should change." });
    expect(ackFromContent([{ type: "text", text: 'Sure: {"kind":"feedback","reply":"a "quote" inside"}' }])).toBeNull();
  });

  it("gives the model the page, forces the reply tool, and counts a canned line with its reason", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    let body: { tools?: { name: string }[]; tool_choice?: { name: string }; messages: { content: string }[] } | null = null;
    const answer = (content: unknown[]) =>
      (async (_url: string, init: RequestInit) => {
        body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ content, usage: { input_tokens: 400, output_tokens: 40 } }), { headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
    const note = { text: "the video is here? I dont see it", name: "Ana", locale: "en", source: "web" as const, canReply: true, replyVia: "telegram" as const, page: "Reel: the clips of a fast reel arrived (sending began at 12:30)." };
    const ok = await composeAck(db, note, answer([{ type: "tool_use", name: "reply", input: { kind: "feedback", reply: "Your clips arrived at 12:30, Ana. The reel is not made yet; it shows on the match page when it is." } }]), NOW);
    expect(ok).toEqual({ kind: "feedback", reply: "Your clips arrived at 12:30, Ana. The reel is not made yet; it shows on the match page when it is.", by: "model" });
    expect(body!.tool_choice?.name).toBe("reply");
    expect(body!.messages[0].content).toContain("what the page shows:\nReel: the clips of a fast reel arrived");

    const canned = await composeAck(db, note, answer([{ type: "text", text: "no json at all" }]), NOW);
    expect(canned.by).toBe("fallback");
    expect(canned.reply).not.toMatch(/Noted|word for word/);
    const counted = await db.select().from(metricsDaily).where(eq(metricsDaily.key, "ack_fallback_unread"));
    expect(counted.reduce((n, r) => n + Number(r.value), 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("the owner's summary of a note", () => {
  const note = { id: "abcdefgh-0000-4000-8000-000000000000", name: "Ana", source: "web", locale: "en", text: "the video is here?", role: null, createdAt: NOW } as const;
  it("says the desk has the note when the desk is on, and how to hand it to a session when it is off", () => {
    delete process.env.NOTE_DESK_TOKEN;
    expect(formatProposal(note, null, "x")).toContain("Open a Claude session and say 'handle note abcdefgh'.");
    process.env.NOTE_DESK_TOKEN = "tok";
    process.env.NOTE_DESK_FIRE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01TEST/fire";
    const on = formatProposal(note, null, "x");
    expect(on).toContain("The note desk has this note and answers the player.");
    expect(on).not.toMatch(/build|skip/);
    // The time is the owner's: Bangkok, never UTC.
    expect(on).toContain("24 Nov, 15:14");
  });
});

void DAY;
