import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { answers, events, listenItems, metricsDaily, scores, slots } from "@/db/schema";
import { listErrors } from "@/lib/alerts";
import { createEvent } from "@/lib/domain/events";
import { generateAnswer, getPublishedAnswer, listPublishedAnswers, parseGenerated, sendWeeklyDigest, setAnswerPublished, weekOfMatches } from "@/lib/listen/answers";
import { approveItem, listenTick, rememberCandidates } from "@/lib/listen/tick";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

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

describe("the Sunday digest: the week's matches as one set, and a digest that fails leaves a trace", () => {
  // Sunday 20 September 2026, 09:00 UTC (16:00 in Bangkok): the Sunday whose digest never arrived.
  const NOW = new Date("2026-09-20T09:00:00Z");
  freezeClock(NOW);
  let db: Db;
  beforeAll(async () => {
    ({ db } = await createTestDb());
  });
  let telegramOk = true;
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "1:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    delete process.env.ANTHROPIC_API_KEY;
    telegramOk = true;
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
        calls.push({ url, body });
        if (url.includes("api.telegram.org") && !telegramOk) return new Response(JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: chat not found" }), { status: 400 });
        if (url.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + calls.length, chat: { id: body?.chat_id } } }), { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  /** A match `daysAgo` before NOW with `seated` seats taken (joined, the last one confirmed). */
  async function match(daysAgo: number, seated: number, o: { type?: "match" | "tournament"; cancelled?: boolean; scored?: boolean; waitlisted?: number } = {}) {
    const org = await makePlayer(db, "Org");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: o.type ?? "match", capacity: o.type === "tournament" ? 8 : undefined, startsAt: new Date(NOW.getTime() - daysAgo * DAY), tz: "Asia/Bangkok", venueName: "Digest Padel", whenFull: "waitlist" });
    for (let pos = 1; pos <= seated; pos++) {
      const p = await makePlayer(db, `P${pos}`);
      await db.update(slots).set({ playerId: p.id, status: pos === seated ? "confirmed" : "joined" }).where(and(eq(slots.eventId, ev.id), eq(slots.position, pos)));
    }
    // The waitlist sits past the capacity with status joined; it is not a seat.
    for (let i = 1; i <= (o.waitlisted ?? 0); i++) {
      const p = await makePlayer(db, `W${i}`);
      await db.insert(slots).values({ eventId: ev.id, position: ev.capacity + i, kind: "open", status: "joined", playerId: p.id });
    }
    if (o.cancelled) await db.update(events).set({ status: "cancelled" }).where(eq(events.id, ev.id));
    if (o.scored) await db.insert(scores).values({ eventId: ev.id, setNumber: 1, sideA: 6, sideB: 4 });
    return ev;
  }

  it("counts the matches that started this week, those that filled, and those with a score", async () => {
    await match(2, 4, { scored: true }); // filled, scored
    await match(3, 3); // filled: three of four is enough to find a fourth
    await match(1, 2, { waitlisted: 2 }); // two seated; the waitlist does not fill it
    await match(4, 0); // nobody came
    await match(2, 4, { cancelled: true }); // cancelled: not a match that was played for
    await match(1, 8, { type: "tournament", scored: true }); // a tournament is not a match
    await match(8, 4, { scored: true }); // last week
    await match(-1, 4); // tomorrow: not started yet
    const since = new Date(NOW.getTime() - 7 * DAY);
    expect(await weekOfMatches(db, since, NOW)).toEqual({ matches: 4, filled: 2, scored: 1 });

    expect(await sendWeeklyDigest(db, NOW)).toBe(true);
    const head = String(calls.find((c) => c.url.includes("sendMessage"))?.body?.text);
    expect(head).toContain("matches 4 → filled 2 → scores 1");
    expect(head).not.toContain("seats");
  });

  it("a digest Telegram refuses is reported, and the next hour sends it", async () => {
    await db.delete(metricsDaily).where(eq(metricsDaily.key, "listen_digest"));
    telegramOk = false;
    expect(await sendWeeklyDigest(db, NOW)).toBe(false);
    const { getDb } = await import("@/db");
    const recorded = (await listErrors(await getDb(), { includeFixed: true })).filter((e) => e.path === "listen/digest");
    expect(recorded.map((e) => e.message)).toEqual(["weekly digest not sent: Telegram answered 400 Bad Request: chat not found"]);
    // Nothing was marked, so the next run is not refused by the once-a-week guard.
    telegramOk = true;
    expect(await sendWeeklyDigest(db, new Date(NOW.getTime() + 3600 * 1000))).toBe(true);
  });

  it("a digest that throws inside the hourly listening step is reported, and the step goes on", async () => {
    await db.delete(metricsDaily).where(eq(metricsDaily.key, "listen_digest"));
    // The digest's first read is metrics_daily; no other listening step reads it with drafting off.
    const broken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "select") return Reflect.get(target, prop, receiver);
        return (...args: Parameters<Db["select"]>) => {
          const q = target.select(...args);
          const from = (t: Parameters<typeof q.from>[0]) => {
            if (t === metricsDaily) throw new Error("metrics_daily went away");
            return q.from(t);
          };
          return new Proxy(q, { get: (qt, p, r) => (p === "from" ? from : Reflect.get(qt, p, r)) });
        };
      },
    }) as Db;
    const summary = await listenTick(broken, NOW, { feeds: [], discord: false });
    expect(summary).toMatchObject({ feeds: 0, asked: 0 });
    const { getDb } = await import("@/db");
    const recorded = (await listErrors(await getDb(), { includeFixed: true })).filter((e) => e.path === "listen/digest");
    expect(recorded.map((e) => e.message)).toContain("metrics_daily went away");
  });
});
