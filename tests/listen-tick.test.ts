import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { listenItems } from "@/db/schema";
import { BUDGET, parseDraft, spentToday } from "@/lib/listen/draft";
import { approveItem, askOwner, draftPending, expireOld, listenTick, rememberCandidates, skipItem } from "@/lib/listen/tick";
import type { FeedSpec } from "@/lib/listen/sources";
import { createTestDb } from "./helpers/db";

const NOW = new Date("2026-09-06T09:00:00Z");
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
    const spent = await spentToday(db, "2026-09-06");
    expect(spent).toEqual({ drafts: 2, input: 1800, output: 240 });

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
    const spent = await spentToday(db, "2026-09-06");
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
    expect(await draftPending(db, NOW)).toEqual({ drafted: 0, relevant: 0, errors: 0 });
    expect(await askOwner(db, NOW)).toBe(0);
  });
});
