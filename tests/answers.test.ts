import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { answers, listenItems } from "@/db/schema";
import { generateAnswer, getPublishedAnswer, listPublishedAnswers, parseGenerated, sendWeeklyDigest, setAnswerPublished } from "@/lib/listen/answers";
import { approveItem, rememberCandidates } from "@/lib/listen/tick";
import { createTestDb } from "./helpers/db";

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let modelText = () => JSON.stringify({ skip: false, title: "How many rounds does an americano with 8 players take?", slug: "Americano 8 Players Rounds!!", question: "We are eight people on two courts. How many rounds until everyone has played with everyone?", answer: "Seven rounds. With eight players every pair partners exactly once across seven rounds, two courts per round.", language: "en" });

function stubNetwork() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      let body: Record<string, unknown> | null = null;
      try {
        body = init?.body && typeof init.body === "string" ? JSON.parse(init.body) : null;
      } catch {
        body = null;
      }
      calls.push({ url, body });
      if (url.includes("api.anthropic.com")) return new Response(JSON.stringify({ content: [{ type: "text", text: modelText() }], usage: { input_tokens: 500, output_tokens: 200 } }), { status: 200 });
      if (url.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + calls.length, chat: { id: body?.chat_id } } }), { status: 200 });
      return new Response("not found", { status: 404 });
    }),
  );
}

describe("answers: model contract", () => {
  it("cleans slugs, caps lengths, honours skip", () => {
    const g = parseGenerated(modelText());
    expect(g).toMatchObject({ skip: false, slug: "americano-8-players-rounds", language: "en" });
    expect(parseGenerated('{"skip": true}')).toEqual({ skip: true });
    expect(parseGenerated('{"skip": false, "title": "x"}')).toBeNull();
    expect(parseGenerated("nope")).toBeNull();
    expect(parseGenerated('{"skip": false, "title": "T", "slug": "Мексикано", "question": "q", "answer": "a", "language": "ru"}')).toBeNull();
  });
});

describe("answers: pages from approvals, digest once a week (db, stubbed network)", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.TELEGRAM_BOT_TOKEN = "1:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    delete process.env.REDDIT_CLIENT_ID;
    stubNetwork();
  });
  afterEach(() => vi.unstubAllGlobals());

  async function draftedItem(externalId: string, title: string) {
    const now = new Date("2026-09-06T09:00:00Z");
    await rememberCandidates(db, [{ source: "reddit", externalId, url: `https://www.reddit.com/r/padel/comments/${externalId}/x/`, title, body: "how do we organise this", author: "/u/a", postedAt: now, threadId: externalId }], now);
    const [item] = await db.select().from(listenItems).where(eq(listenItems.externalId, externalId));
    await db.update(listenItems).set({ status: "drafted", draft: "Seven rounds with eight players; every pair partners once.", language: "en" }).where(eq(listenItems.id, item.id));
    return (await db.select().from(listenItems).where(eq(listenItems.id, item.id)))[0];
  }

  it("approving grows a published page once; slugs stay unique; unpublish hides it", async () => {
    const item = await draftedItem("t3_ans1", "Americano with 8 players: how many rounds?");
    const res = await approveItem(db, item.id, new Date("2026-09-06T09:05:00Z"));
    expect(res.status).toBe("approved_manual");
    const page = await getPublishedAnswer(db, "americano-8-players-rounds");
    expect(page).not.toBeNull();
    expect(page!.sourceItemId).toBe(item.id);
    expect(await generateAnswer(db, item)).toMatchObject({ id: page!.id });
    expect(calls.filter((c) => c.url.includes("anthropic")).length).toBe(1);

    const second = await draftedItem("t3_ans2", "Same question again");
    await approveItem(db, second.id, new Date("2026-09-06T09:06:00Z"));
    const all = await listPublishedAnswers(db);
    expect(all.map((a) => a.slug).sort()).toEqual(["americano-8-players-rounds", "americano-8-players-rounds-2"]);

    await setAnswerPublished(db, page!.id, false);
    expect(await getPublishedAnswer(db, "americano-8-players-rounds")).toBeNull();
    expect((await listPublishedAnswers(db)).length).toBe(1);
    await setAnswerPublished(db, page!.id, true);
    expect((await listPublishedAnswers(db)).length).toBe(2);
  });

  it("skips situational replies and never throws when the model misbehaves", async () => {
    modelText = () => '{"skip": true}';
    const item = await draftedItem("t3_ans3", "Anyone in Murcia this weekend?");
    expect(await generateAnswer(db, item)).toBeNull();
    modelText = () => "garbage";
    const item2 = await draftedItem("t3_ans4", "Padel app for my crew?");
    expect(await generateAnswer(db, item2)).toBeNull();
    expect(await db.select().from(answers).where(eq(answers.sourceItemId, item2.id))).toHaveLength(0);
  });

  it("the Sunday digest goes out once, lists new pages with Unpublish buttons, and stays quiet on other days", async () => {
    const monday = new Date("2026-09-07T09:00:00Z");
    expect(await sendWeeklyDigest(db, monday)).toBe(false);
    const sundayEarly = new Date("2026-09-06T05:00:00Z");
    expect(await sendWeeklyDigest(db, sundayEarly)).toBe(false);
    const sunday = new Date("2026-09-06T09:30:00Z");
    expect(await sendWeeklyDigest(db, sunday)).toBe(true);
    const tg = calls.filter((c) => c.url.includes("sendMessage"));
    expect(tg.length).toBeGreaterThanOrEqual(2);
    expect(String(tg[0].body?.text)).toContain("Kicksmash, this week");
    expect(JSON.stringify(tg[1].body?.reply_markup)).toContain("lu:");
    expect(await sendWeeklyDigest(db, new Date("2026-09-06T12:00:00Z"))).toBe(false);
    const digested = await db.select().from(answers);
    expect(digested.filter((a) => a.digestedAt).length).toBe(2);
  });
});
