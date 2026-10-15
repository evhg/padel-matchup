import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { Db } from "@/db";
import { errorEvents, metricsDaily, players } from "@/db/schema";
import { blankValues, describeError, ERROR_ALERTS, errorPath } from "@/lib/alerts";
import { onRequestError } from "@/instrumentation";

/**
 * A server render error reached the error store only as the browser's report until 15 October 2026:
 * src/instrumentation.ts did not exist, so a crash of the match page left a client row with the
 * message Next.js shows a browser, and a client row never alerts the owner. Next.js calls
 * `onRequestError` as below (`instrumentationOnRequestError` in next/dist/server/base-server.js:
 * the error, `{ path, method, headers }`, and the route's context).
 */
const request = (path: string) => ({ path, method: "GET", headers: {} });
const render = { routerKind: "App Router", routePath: "/[code]", routeType: "render", renderSource: "react-server-components", revalidateReason: undefined } as const;

let db: Db;
beforeAll(async () => {
  process.env.NEXT_RUNTIME = "nodejs";
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_OWNER_ID;
  // The app's own database, the one a route reaches: this file's, empty of errors at the start.
  db = await (await import("@/db")).getDb();
});
afterEach(() => vi.unstubAllGlobals());

const rows = () => db.select().from(errorEvents);
const serverErrorsCounted = async () => (await db.select().from(metricsDaily).where(eq(metricsDaily.key, "errors_server"))).reduce((n, r) => n + Number(r.value), 0);

describe("a server error nobody caught", () => {
  it("reaches the store as a server row with its own message, its stack and the page's path", async () => {
    const before = await rows();
    const counted = await serverErrorsCounted();
    const err = Object.assign(new Error("Cannot read properties of undefined (reading 'roster')"), { digest: "2817361982" });
    await onRequestError(err, request("/X9nQ"), render);
    const added = (await rows()).filter((r) => !before.some((b) => b.fingerprint === r.fingerprint));
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ kind: "server", path: "/X9nQ", count: 1 });
    expect(added[0].message).toBe("Cannot read properties of undefined (reading 'roster') [digest 2817361982]");
    expect(added[0].stack).toContain("instrumentation.test");
    expect(await serverErrorsCounted()).toBe(counted + 1);
  });

  it("writes nothing for Next.js's own control flow, nor on the edge runtime", async () => {
    const before = (await rows()).length;
    const counted = await serverErrorsCounted();
    await onRequestError(Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT;replace;/me;307;" }), request("/X9nQ"), render);
    await onRequestError(Object.assign(new Error("NEXT_HTTP_ERROR_FALLBACK;404"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" }), request("/ZZZZ"), render);
    await onRequestError(Object.assign(new Error("Dynamic server usage: headers"), { digest: "DYNAMIC_SERVER_USAGE" }), request("/X9nQ"), render);
    process.env.NEXT_RUNTIME = "edge";
    try {
      await onRequestError(new Error("a crash in the middleware"), request("/ru"), { ...render, routePath: "/middleware", routeType: "middleware" });
    } finally {
      process.env.NEXT_RUNTIME = "nodejs";
    }
    expect(await rows()).toHaveLength(before);
    expect(await serverErrorsCounted()).toBe(counted);
  });

  it("keeps no value of a failed query, the one the database's reason quotes included, and names that reason", async () => {
    // A real failed query: the token sits in its params, the id is not a uuid, and the database says so.
    let thrown: unknown;
    try {
      await db.select({ id: players.id }).from(players).where(and(eq(players.personalToken, "SeCrEtToKeN12"), eq(players.id, "not-a-uuid")));
    } catch (e) {
      thrown = e;
    }
    expect(String((thrown as Error).message)).toContain("SeCrEtToKeN12");
    await onRequestError(thrown, request("/p/SeCrEtToKeN12"), { ...render, routePath: "/p/[token]" });
    const row = (await rows()).find((r) => r.message.includes("failed query: select"));
    // The reason quoted the refused value until the review of 15 October 2026: `/m/<36 dashes>` stored the dashes.
    expect(row?.message).toMatch(/^invalid input syntax for type uuid: "…" · failed query: select "id" from "players" where/);
    expect(row?.path).toBe("/p/:secret");
    expect(JSON.stringify(await rows())).not.toContain("SeCrEtToKeN12");
    expect(JSON.stringify(await rows())).not.toContain("not-a-uuid");
  });

  it("blanks every value a database's reason quotes, keeps the names of the schema, and makes many refused values one fingerprint", () => {
    const query = 'select "id" from "players" where "players"."id" = $1';
    for (const [reason, kept] of [
      ['invalid input syntax for type uuid: "not-a-uuid"', 'invalid input syntax for type uuid: "…"'],
      // A quote inside the value does not end it early.
      ['invalid input syntax for type uuid: "a"b-SeCrEt"', 'invalid input syntax for type uuid: "…"'],
      ['invalid input value for enum slot_status: "SeCrEt"', 'invalid input value for enum slot_status: "…"'],
      ['time zone "SeCrEt/Zone" not recognized', 'time zone "…" not recognized'],
      ['value "12345678901234" is out of range for type integer', 'value "…" is out of range for type integer'],
      // The schema's names stay: the query names the table, a constraint is named as one.
      ['relation "players" does not exist', 'relation "players" does not exist'],
      ['duplicate key value violates unique constraint "players_personal_token_idx"', 'duplicate key value violates unique constraint "players_personal_token_idx"'],
      ["canceling statement due to statement timeout", "canceling statement due to statement timeout"],
    ] as const)
      expect(blankValues(reason, query), reason).toBe(kept);

    const failed = (value: string) => Object.assign(new Error(`Failed query: ${query}\nparams: ${value}`), { cause: new Error(`invalid input syntax for type uuid: "${value}"`) });
    const [a, b] = [describeError(failed("------------------------------------")), describeError(failed("-----------------------------------b"))];
    expect(a.message).toBe(`invalid input syntax for type uuid: "…" · failed query: ${query}`);
    expect(b.message).toBe(a.message);
    expect(`${a.stack}${b.stack}`).not.toMatch(/---|params/);
  });

  it("writes nothing for the HTML pass's copy of a server component's error, which arrives with Next.js's sentence in place of the message", async () => {
    const before = (await rows()).length;
    const copy = Object.assign(new Error("An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error."), { digest: "3141592653" });
    await onRequestError(copy, request("/X9nQ"), { ...render, renderSource: "server-rendering" });
    expect(await rows()).toHaveLength(before);
  });

  it("keeps no credential from the path: no query string, and a personal, manage or invite link blanked", async () => {
    for (const [raw, kept] of [
      ["/X9nQ", "/X9nQ"],
      ["/X9nQ?s=wa&join=1", "/X9nQ"],
      ["https://kicksma.sh/p/AbCdEfGhJkLm?next=%2FX9nQ", "/p/:secret"],
      ["/p/AbCdEfGhJkLm/X9nQ", "/p/:secret/X9nQ"],
      ["/X9nQ/manage/mng0123456789", "/X9nQ/manage/:secret"],
      ["/X9nQ/i/inv0123456", "/X9nQ/i/:secret"],
      ["/v/warehaus/manage/tok-warehaus-abc", "/v/warehaus/manage/:secret"],
      ["/coach/join/K7Q2", "/coach/join/:secret"],
      ["/c/olga/pay/owed/7f3a9c2e-1d4b-4a2f-9c1e-0b2a3c4d5e6f", "/c/olga/pay/owed/:secret"],
      ["/coaches/join", "/coaches/join"],
      // A job's own label passes as it is.
      ["/api/cron/push#scrape", "/api/cron/push#scrape"],
      ["listen/digest", "listen/digest"],
    ] as const)
      expect(errorPath(raw), raw).toBe(kept);
    expect(errorPath("")).toBeNull();
    expect(errorPath(null)).toBeNull();

    await onRequestError(new Error("personal link page fell over"), request("/p/AbCdEfGhJkLm?next=%2FX9nQ"), { ...render, routePath: "/p/[token]" });
    const [row] = (await rows()).filter((r) => r.message === "personal link page fell over");
    expect(row.path).toBe("/p/:secret");
    expect(JSON.stringify(await rows())).not.toContain("AbCdEfGhJkLm");
  });

  it("returns before the report is done when a route handler's error comes after its request scope, and hands the report to the platform's waitUntil", async () => {
    // Next.js 15.5 calls the hook for a route handler (an API route, an opengraph image, a QR) from the
    // route template's catch, after the request scope closed, and sends the 500 only when the hook
    // returns. after() throws there, and the report with its Telegram line ran in line until the review
    // of 15 October 2026: a 500 waited 3 s for a slow Telegram. Here Telegram does not answer until the
    // test says so, and the platform's request context (Vercel's) takes the work.
    await db.delete(errorEvents);
    await db.delete(metricsDaily).where(like(metricsDaily.key, "rl:error_alert%"));
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    const owner: string[] = [];
    let answer = () => {};
    const telegramAnswers = new Promise<void>((r) => (answer = r));
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: number; text?: string };
      if (String(url).includes("api.telegram.org") && body.chat_id === 777) owner.push(String(body.text));
      await telegramAnswers;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
    });
    const REQUEST_CONTEXT = Symbol.for("@next/request-context");
    const g = globalThis as unknown as Record<symbol, unknown>;
    const handed: Promise<unknown>[] = [];
    g[REQUEST_CONTEXT] = { get: () => ({ waitUntil: (p: Promise<unknown>) => handed.push(p) }) };
    try {
      const route = { routerKind: "App Router", routePath: "/m/[id]/opengraph-image", routeType: "route", revalidateReason: undefined } as const;
      const hook = Promise.resolve(onRequestError(new Error("opengraph image fell over"), request("/m/x/opengraph-image"), route)).then(() => "returned");
      expect(await Promise.race([hook, new Promise((r) => setTimeout(() => r("still waiting"), 2000))])).toBe("returned");
      expect(handed).toHaveLength(1);
      answer();
      await Promise.all(handed);
      expect((await rows()).filter((r) => r.message === "opengraph image fell over")).toHaveLength(1);
      expect(owner).toHaveLength(1);
      expect(owner[0]).toContain("New production error (server): opengraph image fell over on /m/x/opengraph-image");
    } finally {
      delete g[REQUEST_CONTEXT];
      answer();
    }
  });

  it("tells the owner once per new error, and a crash loop never floods the owner's Telegram", async () => {
    // The hour's alert budget is a rate row of one clock hour, so this test starts with no line spent,
    // at a fixed instant: a real clock could cross the hour in the middle of it.
    await db.delete(errorEvents);
    await db.delete(metricsDaily).where(like(metricsDaily.key, "rl:error_alert%"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:20:00Z"));
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    const owner: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: number; text?: string };
      if (String(url).includes("api.telegram.org") && body.chat_id === 777) owner.push(String(body.text));
      return new Response(JSON.stringify({ ok: true, result: { message_id: owner.length } }), { headers: { "content-type": "application/json" } });
    });
    try {
      // The token stays out of the owner's line as it stays out of the row.
      await onRequestError(new Error("personal page crashed"), request("/p/ZyXwVuTsRqPn"), { ...render, routePath: "/p/[token]" });
      expect(owner).toHaveLength(1);
      expect(owner[0]).toContain("New production error (server): personal page crashed on /p/:secret");
      expect(owner.join("\n")).not.toContain("ZyXwVuTsRqPn");

      // A crash loop: the match page fails the same way on every load, each with its own id in the message.
      for (let i = 0; i < 20; i++) {
        const id = `7f3a9c2e-1d4b-4a2f-9c1e-${String(i).padStart(12, "0")}`;
        await onRequestError(new Error(`event ${id} has no creator`), request("/X9nQ"), render);
      }
      expect(owner).toHaveLength(2);
      expect(owner[1]).toContain("on /X9nQ");
      const loop = (await rows()).find((r) => r.message.endsWith("has no creator"));
      expect(loop?.count).toBe(20);

      // A storm of different errors: never more than the hour's budget, the two above included.
      for (const w of ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"]) await onRequestError(new Error(`storm ${w} failed`), request(`/S${w}`), render);
      expect(owner.length).toBe(ERROR_ALERTS.perHour);
    } finally {
      vi.useRealTimers();
    }
  });
});
