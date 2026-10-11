import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { freezeClock } from "./helpers/clock";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { listenItems, metricsDaily } from "@/db/schema";
import { serviceBoard } from "@/lib/ops/services";
import { recordModelCall, REQUEUED_ERROR } from "@/lib/ops/anthropic";
import { BUDGET, draftReply, parseDraft, spentToday, withinBudget } from "@/lib/listen/draft";
import { approveItem, askOwner, draftPending, expireOld, LIMITS, listenTick, rememberCandidates, skipItem } from "@/lib/listen/tick";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import type { FeedSpec } from "@/lib/listen/sources";
import { createTestDb } from "./helpers/db";

const NOW = new Date("2026-09-07T09:00:00Z");
freezeClock(NOW);
const iso = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3600 * 1000).toISOString();

const atom = (entries: { id: string; title: string; body: string; when: string }[]) =>
  `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries
    .map(
      (e) => `<entry><author><name>/u/${e.id}</name></author><content type="html">&lt;p&gt;${e.body}&lt;/p&gt;</content><id>t3_${e.id}</id><link href="https://www.reddit.com/r/padel/comments/${e.id}/x/" /><updated>${e.when}</updated><title>${e.title}</title></entry>`,
    )
    .join("")}</feed>`;

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[] = [];
let anthropicReply = (title: string) => ({ relevant: true, kind: "asks_for_tool", language: "en", reply: `Reply about: ${title}`, reason: "asks for a tool", mentionsKicksmash: false });
let redditOk = true;

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
      if (url.includes("reddit.com/r/padel/new")) {
        return new Response(
          atom([
            { id: "aaa111", title: "App to organise padel matches with my WhatsApp group?", body: "We are 12 people and it is chaos", when: iso(2) },
            { id: "bbb222", title: "Look at this rally", body: "padel highlights from Madrid", when: iso(3) },
            { id: "ccc333", title: "Padel mexicano schedule for 8?", body: "How do you run a mexicano with 8 players and 2 courts", when: iso(5) },
            { id: "old444", title: "Old app question about padel", body: "app for padel organising", when: iso(24 * 9) },
          ]),
          { status: 200, headers: { "content-type": "application/atom+xml" } },
        );
      }
      if (url.includes("hn.algolia.com")) return new Response(JSON.stringify({ hits: [] }), { status: 200 });
      if (url.includes("api.anthropic.com")) {
        const user = String((body?.messages as { content: string }[] | undefined)?.[0]?.content ?? "");
        const title = user.match(/Title: (.*)/)?.[1] ?? "";
        const draft = anthropicReply(title);
        return new Response(JSON.stringify({ content: [{ type: "text", text: "```json\n" + JSON.stringify(draft) + "\n```" }], usage: { input_tokens: 900, output_tokens: 120 } }), { status: 200 });
      }
      if (url.includes("api.telegram.org")) {
        const method = url.split("/").pop()!;
        return new Response(JSON.stringify({ ok: true, result: method === "sendMessage" ? { message_id: 500 + calls.length, chat: { id: body?.chat_id } } : true }), { status: 200 });
      }
      if (url.includes("reddit.com/api/v1/access_token")) return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
      if (url.includes("oauth.reddit.com/api/comment")) {
        return redditOk
          ? new Response(JSON.stringify({ json: { errors: [], data: { things: [{ data: { id: "t1_new1", permalink: "/r/padel/comments/aaa111/x/new1/" } }] } } }), { status: 200 })
          : new Response(JSON.stringify({ json: { errors: [["RATELIMIT", "you are doing that too much", "ratelimit"]] } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
}
const FEEDS: FeedSpec[] = [
  { id: "reddit-test", kind: "feed", url: "https://www.reddit.com/r/padel/new/.rss", source: "reddit" },
  { id: "hn-test", kind: "hn", url: "https://hn.algolia.com/api/v1/search_by_date?query=padel", source: "hn" },
];

describe("listen: drafting contract", () => {
  it("parses model output with or without fences and never trusts relevant without a reply", () => {
    expect(parseDraft('{"relevant": true, "kind": "asks_how_to", "language": "es", "reply": "Prueba un americano.", "reason": "x", "mentionsKicksmash": false}')).toMatchObject({ relevant: true, kind: "asks_how_to", language: "es" });
    expect(parseDraft("```json\n{\"relevant\": true, \"kind\": \"other\", \"language\": \"en\", \"reply\": null, \"reason\": \"noise\"}\n```")).toMatchObject({ relevant: false, reply: null });
    expect(parseDraft("no json here")).toBeNull();
    expect(parseDraft('{"relevant": false, "reply": "should be dropped", "kind": "discussion"}')?.reply).toBeNull();
    expect(parseDraft('{"relevant": true, "reply": "see kicksma.sh", "kind": "asks_for_tool"}')?.mentionsKicksmash).toBe(true);
  });
});

describe("listen: the hourly tick (db, stubbed network)", () => {
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
    delete process.env.REDDIT_CLIENT_SECRET;
    delete process.env.REDDIT_USERNAME;
    delete process.env.REDDIT_PASSWORD;
    redditOk = true;
    anthropicReply = (title) => ({ relevant: true, kind: "asks_for_tool", language: "en", reply: `Reply about: ${title}`, reason: "asks for a tool", mentionsKicksmash: false });
    stubNetwork();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("remembers fresh items once, gates them, drafts within budget, asks the owner, and never posts by itself", async () => {
    const summary = await listenTick(db, NOW, { feeds: FEEDS });
    expect(summary).toMatchObject({ feeds: 2, feedErrors: 0, fetched: 4, remembered: 3, drafted: 2, relevant: 2, asked: 2 });
    const rows = await db.select().from(listenItems);
    const byId = Object.fromEntries(rows.map((r) => [r.externalId, r]));
    expect(byId.t3_bbb222.status).toBe("irrelevant");
    expect(byId.t3_aaa111.status).toBe("drafted");
    expect(byId.t3_aaa111.draft).toContain("Reply about");
    expect(byId.t3_aaa111.threadId).toBe("t3_aaa111");
    expect(byId.t3_aaa111.notifiedAt).not.toBeNull();
    expect(byId.t3_old444).toBeUndefined();
    const dms = calls.filter((c) => c.url.includes("sendMessage"));
    expect(dms).toHaveLength(2);
    expect(dms[0].body?.chat_id).toBe(777);
    expect(JSON.stringify(dms[0].body?.reply_markup)).toContain(`la:${byId.t3_aaa111.id}`);
    expect(calls.some((c) => c.url.includes("oauth.reddit.com"))).toBe(false);
    const spent = await spentToday(db, "2026-09-07");
    expect(spent).toEqual({ drafts: 2, failed: 0, input: 1800, output: 240, apart: { calls: 0, input: 0, output: 0 } });

    // The second run is idempotent: nothing new, nothing re-asked.
    const again = await listenTick(db, NOW, { feeds: FEEDS });
    expect(again).toMatchObject({ remembered: 0, drafted: 0, asked: 0 });
    expect(calls.filter((c) => c.url.includes("sendMessage"))).toHaveLength(2);
  });

  it("approval without Reddit keys marks the item for a manual post; skip and expiry work", async () => {
    const [item] = await db.select().from(listenItems).where(eq(listenItems.externalId, "t3_aaa111"));
    const res = await approveItem(db, item.id, NOW);
    expect(res.status).toBe("approved_manual");
    const skipped = await skipItem(db, (await db.select().from(listenItems).where(eq(listenItems.externalId, "t3_ccc333")))[0].id, NOW);
    expect(skipped?.status).toBe("skipped");
    await rememberCandidates(db, [{ source: "rss", externalId: "stale-1", url: "https://x/1", title: "padel app for organising", body: "", author: null, postedAt: new Date(NOW.getTime() - 6 * 24 * 3600 * 1000), threadId: null }], NOW);
    expect(await expireOld(db, new Date(NOW.getTime() + 2 * 24 * 3600 * 1000))).toBe(1);
  });

  it("with Reddit keys, approve posts the comment and records the permalink; a failure keeps it approved with the error", async () => {
    process.env.REDDIT_CLIENT_ID = "id";
    process.env.REDDIT_CLIENT_SECRET = "secret";
    process.env.REDDIT_USERNAME = "kicksmash";
    process.env.REDDIT_PASSWORD = "pw";
    await rememberCandidates(db, [{ source: "reddit", externalId: "t3_ddd444", url: "https://www.reddit.com/r/padel/comments/ddd444/x/", title: "Which app to organise padel?", body: "Looking for a tool", author: "/u/d", postedAt: new Date(NOW.getTime() - 3600 * 1000), threadId: "t3_ddd444" }], NOW);
    await draftPending(db, NOW);
    const [item] = await db.select().from(listenItems).where(eq(listenItems.externalId, "t3_ddd444"));
    expect(item.status).toBe("drafted");
    const posted = await approveItem(db, item.id, NOW);
    expect(posted).toMatchObject({ status: "posted", url: "https://www.reddit.com/r/padel/comments/aaa111/x/new1/" });
    expect((await db.select().from(listenItems).where(eq(listenItems.id, item.id)))[0]).toMatchObject({ status: "posted", replyUrl: "https://www.reddit.com/r/padel/comments/aaa111/x/new1/" });
    expect(await approveItem(db, item.id, NOW)).toMatchObject({ status: "already" });

    redditOk = false;
    await rememberCandidates(db, [{ source: "reddit", externalId: "t3_eee555", url: "https://www.reddit.com/r/padel/comments/eee555/x/", title: "Padel americano app?", body: "for 12 players", author: "/u/e", postedAt: new Date(NOW.getTime() - 1800 * 1000), threadId: "t3_eee555" }], NOW);
    await draftPending(db, NOW);
    const [second] = await db.select().from(listenItems).where(eq(listenItems.externalId, "t3_eee555"));
    const failed = await approveItem(db, second.id, NOW);
    expect(failed).toMatchObject({ status: "failed" });
    expect((await db.select().from(listenItems).where(eq(listenItems.id, second.id)))[0]).toMatchObject({ status: "approved" });
  });

  it("respects the daily ceilings and the owner ask limit", async () => {
    const many = Array.from({ length: BUDGET.draftsPerDay + 5 }, (_, i) => ({ source: "reddit" as const, externalId: `t3_bulk${i}`, url: `https://www.reddit.com/r/padel/comments/bulk${i}/x/`, title: `Padel app question ${i}`, body: "which app to organise matches", author: null, postedAt: new Date(NOW.getTime() - i * 60_000), threadId: `t3_bulk${i}` }));
    await rememberCandidates(db, many, NOW);
    let drafted = 0;
    for (let i = 0; i < 12; i++) drafted += (await draftPending(db, NOW)).drafted;
    const spent = await spentToday(db, "2026-09-07");
    expect(spent.drafts).toBeLessThanOrEqual(BUDGET.draftsPerDay);
    expect(drafted).toBeLessThanOrEqual(BUDGET.draftsPerDay);
    const asked = await askOwner(db, NOW);
    const askedTotal = (await db.select().from(listenItems)).filter((r) => r.notifiedAt).length;
    expect(askedTotal).toBeLessThanOrEqual(6);
    expect(asked).toBeLessThanOrEqual(6);
  });

  it("is inert without the API key and without an owner", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TELEGRAM_OWNER_ID;
    await rememberCandidates(db, [{ source: "reddit", externalId: "t3_fff666", url: "https://www.reddit.com/r/padel/comments/fff666/x/", title: "Padel app?", body: "organise", author: null, postedAt: NOW, threadId: "t3_fff666" }], NOW);
    expect(await draftPending(db, NOW)).toEqual({ drafted: 0, relevant: 0, errors: 0, refused: false });
    expect(await askOwner(db, NOW)).toBe(0);
  });
});

// From 5 October 2026 every model call answered 401 for six days: 165 drafts counted with no tokens,
// and the service board stayed green. A failed call is a failure, never a draft, and a refused key
// stops the run at the first refusal and turns the board's Anthropic row red.
describe("listen: a failed model call is visible", () => {
  let db: Db;
  let close: () => Promise<void>;
  let status = 401;
  let anthropicCalls = 0;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    anthropicCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        if (!String(input).includes("api.anthropic.com")) return new Response("not found", { status: 404 });
        anthropicCalls++;
        if (status !== 200) return new Response(JSON.stringify({ type: "error", error: { type: status === 401 ? "authentication_error" : "api_error", message: "no" } }), { status });
        const draft = { relevant: true, kind: "asks_for_tool", language: "en", reply: "A reply", reason: "x", mentionsKicksmash: false };
        return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(draft) }], usage: { input_tokens: 900, output_tokens: 120 } }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, key)))[0]?.value ?? 0);

  it("stops at the first 401, counts it as a failure, keeps the items for a new key, and turns the board red", async () => {
    const three = [1, 2, 3].map((i) => ({ source: "reddit" as const, externalId: `t3_key${i}`, url: `https://www.reddit.com/r/padel/comments/key${i}/x/`, title: `Padel app question ${i}`, body: "which app to organise matches", author: null, postedAt: new Date(NOW.getTime() - i * 60_000), threadId: `t3_key${i}` }));
    await rememberCandidates(db, three, NOW);
    status = 401;
    const run = await draftPending(db, NOW);
    expect(anthropicCalls).toBe(1);
    expect(run).toMatchObject({ drafted: 0, errors: 1, refused: true });
    expect((await db.select().from(listenItems)).map((r) => r.status)).toEqual(["new", "new", "new"]);
    expect(await metric("listen_drafts")).toBe(0);
    expect(await metric("anthropic_failed")).toBe(1);
    const red = (await serviceBoard(db, NOW)).rows.find((r) => r.key === "anthropic")!;
    expect(red.state).toBe("alert");
    expect(red.usage).toContain("the key was refused: set a new ANTHROPIC_API_KEY");

    // A server error is a failure too, but not a refused key: the run goes on.
    status = 500;
    expect(await draftPending(db, NOW)).toMatchObject({ drafted: 0, errors: 3, refused: false });
    expect(anthropicCalls).toBe(4);
    expect(await metric("anthropic_failed")).toBe(4);
    expect(await metric("listen_drafts")).toBe(0);
  });

  it("a refused key is still a refused key when the metrics write fails", async () => {
    status = 401;
    // The metrics table refuses every write; the refusal must still stop the run.
    const broken = new Proxy(db, {
      get(target, prop) {
        if (prop === "insert") return (table: unknown) => (table === metricsDaily ? { values: () => ({ onConflictDoUpdate: async () => { throw new Error("connection reset"); } }) } : target.insert(table as never));
        const v = Reflect.get(target, prop, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Db;
    const before = await metric("anthropic_failed");
    const out = await draftReply(broken, { source: "reddit", url: "https://www.reddit.com/r/padel/comments/key8/x/", title: "Padel app question 8", body: "which app", author: null, postedAt: NOW }, fetch, NOW);
    expect(out).toMatchObject({ draft: null, refused: true });
    expect(await metric("anthropic_failed")).toBe(before);
  });

  it("a new key that answers turns the row back and counts the draft", async () => {
    await rememberCandidates(db, [{ source: "reddit", externalId: "t3_key9", url: "https://www.reddit.com/r/padel/comments/key9/x/", title: "Padel app question 9", body: "which app to organise matches", author: null, postedAt: NOW, threadId: "t3_key9" }], NOW);
    status = 200;
    const later = new Date(NOW.getTime() + 60_000);
    expect(await draftPending(db, later)).toMatchObject({ drafted: 1, refused: false });
    expect(await metric("listen_drafts")).toBe(1);
    const row = (await serviceBoard(db, later)).rows.find((r) => r.key === "anthropic")!;
    expect(row.state).not.toBe("alert");
    expect(row.usage).not.toContain("refused");
  });
});

// From 5 to 11 October 2026 the dead key failed 176 listening items for good ("API key is invalid.",
// "invalid x-api-key"), before a refusal kept items new. A failed item is never drafted again, so the
// first call a new key gets accepted puts the refused ones still inside the window back to new, in one
// update. Every other failure stays failed, and a later accepted call touches nothing.
describe("listen: a new key drafts the questions the dead key failed", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
  const secondsOn = (s: number) => new Date(NOW.getTime() + s * 1000);
  const statusOf = async () => Object.fromEntries((await db.select().from(listenItems)).map((r) => [r.externalId, { status: r.status, lastError: r.lastError, draftedAt: r.draftedAt }]));

  it("the first accepted call after a refusal puts the refused items in the window back to new, once", async () => {
    const seed: [string, string, number][] = [
      ["t3_dead1", "API key is invalid.", 2],
      ["t3_dead2", "invalid x-api-key", 30],
      ["t3_dead3", "HTTP 401", 100],
      // Older than the 7-day window: expired in all but name, and stays as it is.
      ["t3_dead4", "invalid x-api-key", 24 * 8],
      // A failure that was not the key's.
      ["t3_dead5", "unparseable answer", 5],
      ["t3_dead6", "Overloaded", 6],
    ];
    await db.insert(listenItems).values(seed.map(([id, lastError, h]) => ({ source: "reddit", externalId: id, url: `https://www.reddit.com/r/padel/comments/${id}/x/`, title: `Padel app ${id}`, body: "which app", postedAt: hoursAgo(h), status: "failed", lastError, draftedAt: hoursAgo(h - 1) })));
    // The dead key's refusal an hour ago; a further refusal changes nothing.
    await recordModelCall(db, { status: 401, ok: false, now: hoursAgo(1) });
    await recordModelCall(db, { status: 401, ok: false, now: hoursAgo(0.5) });
    expect(Object.values(await statusOf()).every((r) => r.status === "failed")).toBe(true);

    await recordModelCall(db, { status: 200, ok: true, usage: { input: 10, output: 5 }, now: NOW });
    const after = await statusOf();
    for (const id of ["t3_dead1", "t3_dead2", "t3_dead3"]) expect(after[id], id).toEqual({ status: "new", lastError: REQUEUED_ERROR, draftedAt: null });
    for (const id of ["t3_dead4", "t3_dead5", "t3_dead6"]) expect(after[id].status, id).toBe("failed");

    // Once: the next accepted call does not put back an item that failed after the new key worked.
    await db.update(listenItems).set({ status: "failed", lastError: "invalid x-api-key" }).where(eq(listenItems.externalId, "t3_dead1"));
    await recordModelCall(db, { status: 200, ok: true, now: secondsOn(60) });
    expect((await statusOf()).t3_dead1.status).toBe("failed");

    // A new refusal, then a key that works again: the window's refused items come back once more.
    await recordModelCall(db, { status: 403, ok: false, now: secondsOn(120) });
    await recordModelCall(db, { status: 200, ok: true, now: secondsOn(180) });
    expect((await statusOf()).t3_dead1.status).toBe("new");
  });

  it("a key fixed before this code ran puts them back on its first accepted call too", async () => {
    // No refusal and no accepted call recorded, as production on the day this ships.
    await db.delete(metricsDaily);
    await db.delete(listenItems);
    await db.insert(listenItems).values({ source: "reddit", externalId: "t3_old1", url: "https://www.reddit.com/r/padel/comments/old1/x/", title: "Padel app", body: "which app", postedAt: hoursAgo(3), status: "failed", lastError: "API key is invalid.", draftedAt: hoursAgo(2) });
    await recordModelCall(db, { status: 200, ok: true, now: NOW });
    expect((await statusOf()).t3_old1.status).toBe("new");
  });
});

// The 176 items the dead key failed went back to new, and a run took three, the newest first, inside the
// day's forty, while new posts alone came close to forty a day (35 on 10 October 2026). So almost none
// of them would have had a draft before they expired, seven days after the post: the first on 12
// October 2026 at 09:00 UTC. Now they go first, oldest first, ten a run, outside the forty.
describe("listen: the put-back items are drafted oldest first, outside the day's forty", () => {
  let db: Db;
  let close: () => Promise<void>;
  let titles: string[] = [];
  let status = 200;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    titles = [];
    status = 200;
    await db.delete(listenItems);
    await db.delete(metricsDaily);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).includes("api.anthropic.com")) return new Response("not found", { status: 404 });
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        titles.push(body.messages[0].content.match(/Title: (.*)/)?.[1] ?? "");
        if (status !== 200) return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status });
        const draft = { relevant: true, kind: "asks_for_tool", language: "en", reply: "A reply", reason: "x", mentionsKicksmash: false };
        return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(draft) }], usage: { input_tokens: 900, output_tokens: 120 } }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  // Hours before NOW, set apart by hand so that "oldest first" is the only order that fits.
  const at = (h: number) => new Date(NOW.getTime() - h * 3600_000);
  const DAY = dayKey(NOW);
  const statusOf = async () => Object.fromEntries((await db.select().from(listenItems)).map((r) => [r.title, { status: r.status, lastError: r.lastError }]));
  const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, key)))[0]?.value ?? 0);
  /** Twelve items the dead key failed, 6 days 23.5 hours old down to 1 hour, then the new key's first accepted call puts them back. */
  async function deadKeyItems(): Promise<number[]> {
    const hours = [7 * 24 - 0.5, 160, 150, 140, 130, 120, 100, 80, 60, 40, 20, 1];
    await db.insert(listenItems).values(hours.map((h) => ({ source: "reddit", externalId: `t3_back${h}`, url: `https://www.reddit.com/r/padel/comments/back${h}/x/`, title: `back ${h}`, body: "which app", postedAt: at(h), status: "failed", lastError: "invalid x-api-key", draftedAt: at(h - 0.5) })));
    await recordModelCall(db, { status: 401, ok: false, now: at(2) });
    await recordModelCall(db, { status: 200, ok: true, now: at(1.5) });
    return hours;
  }
  /** Three of today's new posts. */
  const newPosts = () => db.insert(listenItems).values([0.2, 0.4, 0.6].map((h) => ({ source: "reddit", externalId: `t3_fresh${h}`, url: `https://www.reddit.com/r/padel/comments/fresh${h}/x/`, title: `fresh ${h}`, body: "which app", postedAt: at(h), status: "new" })));

  it("drafts ten a run, the oldest first, skips one that expires before the next run, and the rest next time", async () => {
    await deadKeyItems();
    expect(Object.values(await statusOf()).every((r) => r.status === "new" && r.lastError === REQUEUED_ERROR)).toBe(true);
    const run = await draftPending(db, NOW);
    // The ten oldest that live past the next run, in the order of their posts; then today's three (none here).
    expect(titles).toEqual(["back 160", "back 150", "back 140", "back 130", "back 120", "back 100", "back 80", "back 60", "back 40", "back 20"]);
    expect(run).toMatchObject({ drafted: 10, refused: false });
    const after = await statusOf();
    expect(after["back 160"]).toEqual({ status: "drafted", lastError: null });
    // Half an hour from expiry: a draft would expire unread, so no call is spent on it.
    expect(after["back 167.5"]).toEqual({ status: "new", lastError: REQUEUED_ERROR });
    expect(after["back 1"]).toEqual({ status: "new", lastError: REQUEUED_ERROR });
    titles = [];
    await draftPending(db, new Date(NOW.getTime() + 3600_000));
    expect(titles).toEqual(["back 1"]);
  });

  it("leaves the day's forty to the new posts, even on a day whose forty are spent", async () => {
    await deadKeyItems();
    await newPosts();
    // Today's forty are spent: the new posts wait for tomorrow, and the put-back items do not.
    await setMetric(db, "listen_drafts", BUDGET.draftsPerDay, DAY);
    await draftPending(db, NOW);
    expect(titles).toHaveLength(LIMITS.requeuedPerRun);
    expect(titles.every((t) => t.startsWith("back "))).toBe(true);
    // A day with room: the catch-up's ten never count against it, and the new posts get their three.
    await setMetric(db, "listen_drafts", 0, DAY);
    await db.delete(metricsDaily).where(eq(metricsDaily.key, "listen_requeued_calls"));
    titles = [];
    await draftPending(db, NOW);
    expect(titles.filter((t) => t.startsWith("back "))).toEqual(["back 1"]);
    expect(titles.filter((t) => t.startsWith("fresh "))).toEqual(["fresh 0.2", "fresh 0.4", "fresh 0.6"]);
    expect(await metric("listen_requeued_calls")).toBe(1);
    // listen_drafts counts every accepted draft (the digest's number); the budget leaves the catch-up's out.
    expect(await metric("listen_drafts")).toBe(4);
    const spent = await spentToday(db, DAY);
    expect(spent.drafts - spent.apart.calls).toBe(3);
    // The dead key's one refusal this morning is the day's one failed call.
    expect(spent.failed).toBe(1);
    expect(await withinBudget(db, NOW)).toBe(true);
  });

  it("stops at a key refused again: the put-back items stay put back, and the new posts get no call", async () => {
    await deadKeyItems();
    await newPosts();
    status = 401;
    const run = await draftPending(db, NOW);
    expect(run.refused).toBe(true);
    expect(titles.every((t) => t.startsWith("back "))).toBe(true);
    const after = await statusOf();
    expect(Object.entries(after).filter(([t]) => t.startsWith("back ")).every(([, r]) => r.status === "new" && r.lastError === REQUEUED_ERROR)).toBe(true);
    expect(Object.entries(after).filter(([t]) => t.startsWith("fresh ")).every(([, r]) => r.status === "new" && r.lastError === null)).toBe(true);
    // The next run makes no call while the newest answer is a refusal.
    titles = [];
    status = 200;
    await draftPending(db, new Date(NOW.getTime() + 3600_000));
    expect(titles.filter((t) => t.startsWith("back "))).toEqual([]);
  });
});
