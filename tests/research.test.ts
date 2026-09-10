import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { listenItems, researchFinds, researchRuns } from "@/db/schema";
import { bumpMetric } from "@/lib/domain/metrics";
import { allowance, canSpendByHand, cycleOf, pacedTarget, PLAN, readMeter } from "@/lib/research/budget";
import { findEmails, findInstagram, findPhone, groundedSearch, hitToCandidate, researchTick } from "@/lib/research/desk";
import { dueQueries, FIND_QUERIES, intervalHours, LISTEN_QUERIES, QUERIES } from "@/lib/research/queries";
import { extractCredits, searchCredits, tavilySearch } from "@/lib/research/tavily";
import { createTestDb } from "./helpers/db";

/** 16 September 00:00 UTC: exactly half of a thirty-day month has passed. */
const NOW = new Date("2026-09-16T00:00:00Z");
const hours = (n: number, from = NOW) => new Date(from.getTime() + n * 3_600_000);

type Call = { url: string; body: Record<string, unknown> | null };
const handleOf = (u: string) => new URL(u).hostname.split(".")[0].replace(/-/g, "_").slice(0, 30);
let calls: Call[] = [];
let planUsage = 100;
let usageOk = true;

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
      if (url.endsWith("/usage")) {
        if (!usageOk) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ key: { usage: planUsage, limit: null }, account: { current_plan: "researcher", plan_usage: planUsage, plan_limit: 1000 } }), { status: 200 });
      }
      if (url.endsWith("/search")) {
        planUsage += body?.search_depth === "advanced" ? 2 : 1;
        const q = String(body?.query ?? "");
        const slug = q.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").slice(0, 40);
        const results = /padel (club|coach|tournament) |community group/.test(q)
          ? [
              { title: `${q} · official site`, url: `https://${slug}.example/contact`, content: "Courts, lessons, contact us", score: 0.9 },
              { title: `${q} on Instagram`, url: `https://www.instagram.com/${slug.slice(0, 20)}/`, content: "photos", score: 0.5 },
              { title: "Buy rackets", url: "https://www.amazon.com/padel", content: "shop", score: 0.4 },
            ]
          : [
              { title: "App to organise padel matches with my WhatsApp group?", url: `https://forum.example/t/${slug}`, content: "We are 12 people and organising games is chaos, any app or tool?", score: 0.8, published_date: hours(-30).toISOString() },
              { title: "Best padel racket 2026", url: `https://blog.example/${slug}`, content: "racket review, carbon face", score: 0.6 },
              { title: "same thread twice", url: `https://forum.example/t/${slug}`, content: "dup", score: 0.1 },
            ];
        return new Response(JSON.stringify({ query: q, results, response_time: 0.4 }), { status: 200 });
      }
      if (url.endsWith("/extract")) {
        const urls = (body?.urls as string[]) ?? [];
        planUsage += Math.ceil(urls.length / 5);
        return new Response(JSON.stringify({ results: urls.map((u) => ({ url: u, raw_content: `Welcome. Contact: hello@${new URL(u).hostname}, +66 81 234 5678. Follow instagram.com/p/xyz/ and instagram.com/${handleOf(u)}/` })), failed_results: [] }), { status: 200 });
      }
      return new Response("not stubbed: " + url, { status: 404 });
    }),
  );
}

describe("research budget", () => {
  it("paces a thousand credits evenly across the month, keeps a reserve, never the last five", () => {
    expect(cycleOf(NOW).elapsed).toBeCloseTo(0.5, 5);
    expect(cycleOf(NOW).daysLeft).toBe(15);
    expect(pacedTarget(NOW)).toBe(Math.floor((PLAN.credits - PLAN.reserve) * 0.5));
    expect(allowance(0, NOW)).toBe(PLAN.perTick);
    expect(allowance(pacedTarget(NOW) - 5, NOW)).toBe(5);
    expect(allowance(pacedTarget(NOW), NOW)).toBe(0);
    expect(allowance(996, new Date("2026-09-30T23:30:00Z"))).toBe(0);
    expect(allowance(930, new Date("2026-09-30T23:30:00Z"))).toBe(9);
    expect(canSpendByHand(994, 1)).toBe(true);
    expect(canSpendByHand(995, 1)).toBe(false);
  });
  it("counts credits the way Tavily bills them", () => {
    expect(searchCredits("basic")).toBe(1);
    expect(searchCredits("advanced")).toBe(2);
    expect(extractCredits(0)).toBe(0);
    expect(extractCredits(5)).toBe(1);
    expect(extractCredits(10)).toBe(2);
    expect(extractCredits(11)).toBe(3);
    expect(extractCredits(5, "advanced")).toBe(2);
  });
});

describe("research queries", () => {
  it("has unique keys, three languages of listening and a find set per city", () => {
    expect(new Set(QUERIES.map((q) => q.key)).size).toBe(QUERIES.length);
    expect(LISTEN_QUERIES.filter((q) => q.lang === "ru").length).toBeGreaterThanOrEqual(8);
    expect(LISTEN_QUERIES.filter((q) => q.lang === "es").length).toBeGreaterThanOrEqual(6);
    expect(FIND_QUERIES.filter((q) => q.city === "Phuket").map((q) => q.find).sort()).toEqual(["club", "coach", "community", "tournament"]);
  });
  it("runs never-run queries first, respects intervals, and backs off queries that yield nothing", () => {
    const q = LISTEN_QUERIES[0];
    const run = (lastRunAt: Date, emptyStreak: number) => ({ key: q.key, lastRunAt, runs: 1, credits: 1, results: 3, newItems: 0, emptyStreak, lastError: null });
    expect(dueQueries(NOW, []).length).toBe(QUERIES.length);
    expect(dueQueries(NOW, [run(hours(-1), 0)]).map((x) => x.key)).not.toContain(q.key);
    expect(dueQueries(NOW, [run(hours(-25), 0)]).map((x) => x.key)).toContain(q.key);
    expect(intervalHours(q, { emptyStreak: 1 })).toBe(48);
    expect(intervalHours(q, { emptyStreak: 9 })).toBe(96);
    expect(dueQueries(NOW, [run(hours(-25), 1)]).map((x) => x.key)).not.toContain(q.key);
    expect(dueQueries(NOW, [run(hours(-49), 1)]).map((x) => x.key)).toContain(q.key);
    // The most overdue known query comes right after the never-run ones.
    const others = QUERIES.filter((x) => x.key !== q.key).map((x) => ({ key: x.key, lastRunAt: hours(-1), runs: 1, credits: 1, results: 0, newItems: 0, emptyStreak: 0, lastError: null }));
    expect(dueQueries(NOW, [...others, run(hours(-100), 0)])[0].key).toBe(q.key);
  });
});

describe("contact parsing", () => {
  it("finds public emails, an Instagram handle and a phone, ignoring assets and post links", () => {
    expect(findEmails("Write to info@club.co.th or Info@Club.co.th, not logo@2x.png nor noreply@wixpress.com")).toEqual(["info@club.co.th"]);
    expect(findInstagram("https://www.instagram.com/p/abc/ then instagram.com/phuketpadel/ and instagram.com/other")).toBe("phuketpadel");
    expect(findInstagram("nothing here")).toBeNull();
    expect(findPhone("call +66 81 234 5678 now")).toBe("+66 81 234 5678");
    expect(findPhone("call 081 234 5678")).toBeNull();
  });
  it("turns a hit into a listening candidate with the page's own date when it is recent", () => {
    const recent = hitToCandidate({ title: "t", url: "https://forum.example/t/1", content: "c", score: 1, publishedAt: hours(-30) }, NOW);
    expect(recent.source).toBe("web");
    expect(recent.externalId).toBe("https://forum.example/t/1");
    expect(recent.postedAt.getTime()).toBe(hours(-30).getTime());
    expect(recent.author).toBe("forum.example");
    expect(hitToCandidate({ title: "t", url: "https://x.example/", content: "c", score: 1, publishedAt: hours(-24 * 40) }, NOW).postedAt.getTime()).toBe(NOW.getTime());
    expect(hitToCandidate({ title: "t", url: "https://x.example/", content: "c", score: 1, publishedAt: null }, NOW).postedAt.getTime()).toBe(NOW.getTime());
  });
});

describe("the research desk", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    vi.stubEnv("TAVILY_API_KEY", "tvly-test-key");
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await close();
  });
  beforeEach(() => {
    planUsage = 100;
    usageOk = true;
    stubNetwork();
  });

  it("client: filters duplicates, reports credits, surfaces errors without spending", async () => {
    const ok = await tavilySearch("padel Phuket where to play join a game", { depth: "basic" });
    expect(ok.ok && ok.hits.length).toBe(2);
    expect(ok.ok && ok.credits).toBe(1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: { error: "Unauthorized" } }), { status: 401 })));
    const bad = await tavilySearch("x");
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toBe("Unauthorized");
    expect(bad.credits).toBe(0);
  });

  it("spends this hour's allowance on the most overdue queries, remembers places, then reads their contacts next hour", async () => {
    const first = await researchTick(db, NOW, fetch, { queries: FIND_QUERIES });
    expect(first.enabled).toBe(true);
    expect(first.meter).toEqual({ used: 100, limit: 1000, source: "tavily" });
    expect(first.allowance).toBe(PLAN.perTick);
    expect(first.searches).toBe(PLAN.perTick);
    expect(first.credits).toBe(PLAN.perTick);
    expect(first.newFinds).toBe(PLAN.perTick * 2);
    expect(first.extracted).toBe(0);
    const finds = await db.select().from(researchFinds);
    expect(finds.length).toBe(PLAN.perTick * 2);
    expect(finds.some((f) => f.domain === "amazon.com")).toBe(false);
    expect(finds.every((f) => f.city && ["club", "coach", "tournament", "community"].includes(f.kind))).toBe(true);
    const runs = await db.select().from(researchRuns);
    expect(runs.length).toBe(PLAN.perTick);
    expect(runs.every((r) => r.newItems === 2 && r.emptyStreak === 0 && r.credits === 1)).toBe(true);

    const second = await researchTick(db, hours(1), fetch, { queries: FIND_QUERIES });
    expect(second.meter?.used).toBe(100 + PLAN.perTick);
    expect(second.extracted).toBeGreaterThanOrEqual(10);
    expect(second.credits).toBe(PLAN.perTick);
    const withMail = await db.select().from(researchFinds).where(eq(researchFinds.kind, "club"));
    const pagesRead = (await db.select().from(researchFinds)).filter((f) => f.extractedAt && !/instagram/.test(f.domain)).length;
    expect(pagesRead).toBeGreaterThan(0);
    expect(second.searches).toBe(PLAN.perTick - extractCredits(pagesRead));
    const page = withMail.find((f) => !/instagram/.test(f.domain) && f.extractedAt);
    expect(page?.emails).toEqual([`hello@${page?.domain}`]);
    expect(page?.phone).toBe("+66 81 234 5678");
    expect(page?.instagram).toBe(handleOf(page!.url));
    const social = withMail.find((f) => /instagram/.test(f.domain) && f.extractedAt);
    expect(social?.instagram).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith("/extract")).length).toBe(1);
  });

  it("listening hits enter the listening desk as source web, gated; a barren query backs off", async () => {
    const t = await researchTick(db, hours(2), fetch, { queries: LISTEN_QUERIES.slice(0, 2) });
    expect(t.searches).toBe(2);
    expect(t.newItems).toBe(4);
    const items = await db.select().from(listenItems).where(eq(listenItems.source, "web"));
    expect(items.length).toBe(4);
    expect(items.filter((i) => i.status === "new").length).toBe(2);
    expect(items.filter((i) => i.status === "irrelevant").length).toBe(2);
    expect(items.find((i) => i.status === "new")?.postedAt.getTime()).toBe(hours(-30).getTime());
    // Same results again a day later: nothing new, the query waits two days now.
    const again = await researchTick(db, hours(26), fetch, { queries: LISTEN_QUERIES.slice(0, 2) });
    expect(again.searches).toBe(2);
    expect(again.newItems).toBe(0);
    const [run] = await db.select().from(researchRuns).where(eq(researchRuns.key, LISTEN_QUERIES[0].key));
    expect(run.emptyStreak).toBe(1);
    expect((await researchTick(db, hours(51), fetch, { queries: LISTEN_QUERIES.slice(0, 2) })).searches).toBe(0);
    expect((await researchTick(db, hours(75), fetch, { queries: LISTEN_QUERIES.slice(0, 2) })).searches).toBe(2);
  });

  it("stops at the pace, at the hard stop, and falls back to our own counter when the meter is silent", async () => {
    planUsage = pacedTarget(hours(3), 1000);
    expect((await researchTick(db, hours(3), fetch, { queries: FIND_QUERIES })).searches).toBe(0);
    planUsage = 996;
    const late = new Date("2026-09-30T23:00:00Z");
    expect((await researchTick(db, late, fetch, { queries: FIND_QUERIES })).allowance).toBe(0);
    usageOk = false;
    await bumpMetric(db, "tavily_calls", 7, "2026-09-02");
    const meter = await readMeter(db, NOW);
    expect(meter.source).toBe("counter");
    expect(meter.used).toBeGreaterThanOrEqual(7);
    expect(meter.limit).toBe(PLAN.credits);
  });

  it("hand searches are cached for a week and refused past the hard stop", async () => {
    const a = await groundedSearch(db, "how much does a padel coach cost in Phuket", { maxResults: 5 }, NOW);
    expect("hits" in a && a.cached).toBe(false);
    expect("hits" in a && a.credits).toBe(1);
    const searches = () => calls.filter((c) => c.url.endsWith("/search")).length;
    const n = searches();
    const b = await groundedSearch(db, "  How much does a padel coach cost in Phuket ", { maxResults: 5 }, hours(24));
    expect("hits" in b && b.cached).toBe(true);
    expect(searches()).toBe(n);
    const c = await groundedSearch(db, "how much does a padel coach cost in Phuket", { maxResults: 5 }, hours(24 * 8));
    expect("hits" in c && c.cached).toBe(false);
    planUsage = 995;
    const d = await groundedSearch(db, "something new", {}, hours(24 * 9));
    expect("error" in d && d.error.startsWith("budget")).toBe(true);
  });

  it("stops at its time budget, and a failed search leaves the query due for the next hour", async () => {
    const tight = await researchTick(db, hours(3), fetch, { queries: LISTEN_QUERIES.slice(2, 4), budgetMs: 0 });
    expect(tight.searches).toBe(0);
    expect(tight.budgetHit).toBe(true);
    // One query answers 500, the next is fine: the bad one keeps no run row (still due), the good one runs; two failures in a row end the hour.
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body && typeof init.body === "string" ? (JSON.parse(init.body) as { query?: string }) : null;
      if (String(input).endsWith("/search") && String(body?.query ?? "").includes("FAILS")) return new Response(JSON.stringify({ detail: { error: "boom" } }), { status: 500 });
      return real(input, init);
    });
    const bad = { key: "listen:en:fails", q: "this one FAILS", lang: "en" as const, kind: "listen" as const, everyHours: 24, timeRange: "week" as const };
    const good = LISTEN_QUERIES[5];
    const t = await researchTick(db, hours(4), fetch, { queries: [bad, good] });
    expect(t.errors).toEqual(["listen:en:fails: boom"]);
    expect(t.searches).toBe(1);
    expect(await db.select().from(researchRuns).where(eq(researchRuns.key, bad.key))).toEqual([]);
    expect(dueQueries(hours(5), await db.select().from(researchRuns), [bad, good]).map((q) => q.key)).toEqual([bad.key]);
    const bad2 = { ...bad, key: "listen:en:fails2", q: "also FAILS" };
    const twice = await researchTick(db, hours(5), fetch, { queries: [bad, bad2, good] });
    expect(twice.errors).toHaveLength(2);
    expect(twice.searches).toBe(0);
    stubNetwork();
  });
});
