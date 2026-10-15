import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { feedback, listenItems, metricsDaily } from "@/db/schema";
import { setMetric } from "@/lib/domain/metrics";
import { composeAck } from "@/lib/feedback/ack";
import { proposeToOwner } from "@/lib/feedback/propose";
import { generateAnswer } from "@/lib/listen/answers";
import { draftReply } from "@/lib/listen/draft";
import { draftPending } from "@/lib/listen/tick";
import { anthropicHeaders, KEY_REFUSED_LINE, keyRefused, modelGate, recordModelCall, REQUEUED_ERROR, restoreRefusedItems } from "@/lib/ops/anthropic";
import { serviceBoard } from "@/lib/ops/services";
import { draftReplyTo, recordInbound } from "@/lib/outreach/desk";
import { freezeClock } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

// On 14 October 2026 the owner's new ANTHROPIC_API_KEY had no workspace. Every Messages API call
// answered a 400 with the words below; the code read the status alone, counted three ordinary
// failures, and failed three listening items for good. The owner kept the key and named its
// workspace (15 October 2026): ANTHROPIC_WORKSPACE_ID, sent as `anthropic-workspace-id` on every call,
// and that answer is a refused key, like a 401.

const NOW = new Date("2026-10-15T09:00:00Z");
freezeClock(NOW);

/** The Messages API's whole answer, as production's `last_error` holds it. */
const NO_WORKSPACE =
  "This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use. Add the header, or use an API key that is scoped to a workspace.";
/** A workspace id of the Console's shape, for these tests only. */
const WORKSPACE = "wrkspc_01TestOnlyNotReal";
const BASE_HEADERS = { "content-type": "application/json", "x-api-key": "sk-test", "anthropic-version": "2023-06-01" };

describe("the Messages API's headers", () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_WORKSPACE_ID;
  });

  it("are the three they always were while ANTHROPIC_WORKSPACE_ID is unset or blank", () => {
    delete process.env.ANTHROPIC_WORKSPACE_ID;
    expect(anthropicHeaders("sk-test")).toEqual(BASE_HEADERS);
    process.env.ANTHROPIC_WORKSPACE_ID = "  \n";
    expect(anthropicHeaders("sk-test")).toEqual(BASE_HEADERS);
  });

  it("name the workspace, trimmed, once it is set", () => {
    process.env.ANTHROPIC_WORKSPACE_ID = `  ${WORKSPACE}\n`;
    expect(anthropicHeaders("sk-test")).toEqual({ ...BASE_HEADERS, "anthropic-workspace-id": WORKSPACE });
  });

  // A seventh desk that wrote its own headers would miss the workspace, as six did until this change.
  it("are built in one place: every Messages API call in src/ takes them from anthropicHeaders", () => {
    const root = path.resolve(__dirname, "..", "src");
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const callers = walk(root).filter((f) => readFileSync(f, "utf8").includes("https://api.anthropic.com/v1/messages"));
    const rel = callers.map((f) => path.relative(root, f).split(path.sep).join("/"));
    expect(rel).toEqual(expect.arrayContaining(["lib/listen/draft.ts", "lib/listen/answers.ts", "lib/feedback/propose.ts", "lib/feedback/ack.ts", "lib/booking/screenshot.ts", "lib/outreach/desk.ts"]));
    for (const [i, f] of callers.entries()) {
      const text = readFileSync(f, "utf8");
      const calls = text.split("https://api.anthropic.com/v1/messages").length - 1;
      expect(text.split("headers: anthropicHeaders(").length - 1, rel[i]).toBe(calls);
      expect(text, rel[i]).not.toContain('"anthropic-version"');
      expect(text, rel[i]).not.toContain('"x-api-key"');
    }
  });
});

describe("a key with no workspace is a refused key", () => {
  it("reads the answer's message beside its status", () => {
    expect(keyRefused(400, NO_WORKSPACE)).toBe(true);
    expect(keyRefused(400, NO_WORKSPACE.toUpperCase())).toBe(true);
    // An unrelated 400 is an ordinary failure: the item fails, the run goes on.
    expect(keyRefused(400, "messages: text content blocks must be non-empty")).toBe(false);
    expect(keyRefused(400, null)).toBe(false);
    expect(keyRefused(400)).toBe(false);
    // The status rule stays.
    expect(keyRefused(401)).toBe(true);
    expect(keyRefused(403, "no")).toBe(true);
    expect(keyRefused(500, "Internal server error")).toBe(false);
    expect(keyRefused(529, "Overloaded")).toBe(false);
  });
});

describe("a key with no workspace, through the listening desk (db, stubbed network)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let seen: Record<string, string>[] = [];
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    delete process.env.ANTHROPIC_WORKSPACE_ID;
    delete process.env.TELEGRAM_OWNER_ID;
    seen = [];
    await db.delete(listenItems);
    await db.delete(metricsDaily);
    // The API as it answered the owner's new key: without the header, the 400; with it, a draft.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        if (!String(input).startsWith("https://api.anthropic.com/v1/messages")) return new Response("not found", { status: 404 });
        const headers = { ...(init?.headers as Record<string, string>) };
        seen.push(headers);
        if (!headers["anthropic-workspace-id"]) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: NO_WORKSPACE } }), { status: 400 });
        const draft = { relevant: true, kind: "asks_for_tool", language: "en", reply: "A reply", reason: "x", mentionsKicksmash: false };
        return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(draft) }], usage: { input_tokens: 900, output_tokens: 120 } }), { status: 200 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_WORKSPACE_ID;
  });

  const at = (h: number) => new Date(NOW.getTime() - h * 3600_000);
  const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, key)))[0]?.value ?? 0);
  const byId = async () => Object.fromEntries((await db.select().from(listenItems)).map((r) => [r.externalId, { status: r.status, lastError: r.lastError }]));
  const post = (id: string, hoursAgo: number, more: Partial<typeof listenItems.$inferInsert> = {}) => ({ source: "reddit", externalId: id, url: `https://www.reddit.com/r/padel/comments/${id}/x/`, title: `Padel app ${id}`, body: "which app to organise matches", postedAt: at(hoursAgo), ...more });

  it("draftReply sends the workspace when it is set, and none when it is not", async () => {
    const c = { source: "reddit" as const, url: "https://www.reddit.com/r/padel/comments/h1/x/", title: "Padel app", body: "which app", author: null, postedAt: NOW };
    await draftReply(db, c, fetch, NOW);
    expect(seen[0]).toEqual(BASE_HEADERS);
    process.env.ANTHROPIC_WORKSPACE_ID = ` ${WORKSPACE} `;
    expect(await draftReply(db, c, fetch, NOW)).toMatchObject({ refused: false, error: null });
    expect(seen[1]).toEqual({ ...BASE_HEADERS, "anthropic-workspace-id": WORKSPACE });
  });

  it("the 400 stops the run, keeps the items new, records the refusal and turns the board red", async () => {
    await db.insert(listenItems).values([post("t3_q1", 1, { status: "new" }), post("t3_q2", 2, { status: "new" }), post("t3_q3", 3, { status: "new" })]);
    const run = await draftPending(db, NOW);
    expect(run).toMatchObject({ drafted: 0, errors: 1, refused: true });
    // One call, then the run stops: the next two would be refused the same way.
    expect(seen).toHaveLength(1);
    expect(Object.values(await byId()).map((r) => r.status)).toEqual(["new", "new", "new"]);
    expect(await metric("anthropic_refused_at")).toBe(Math.floor(NOW.getTime() / 1000));
    expect(await metric("anthropic_failed")).toBe(1);
    expect(await metric("listen_drafts")).toBe(0);
    const row = (await serviceBoard(db, NOW)).rows.find((r) => r.key === "anthropic")!;
    expect(row.state).toBe("alert");
    expect(row.usage.startsWith(KEY_REFUSED_LINE)).toBe(true);
    expect(row.usage).toContain("ANTHROPIC_WORKSPACE_ID");
    // The paths a person waits on (the booking screenshot) ask the same gate, and stop.
    expect((await modelGate(db, NOW)).refused).toBe(true);
  });

  it("recordModelCall writes anthropic_refused_at for the workspace answer, and not for an unrelated 400", async () => {
    await recordModelCall(db, { status: 400, ok: false, error: "messages: text content blocks must be non-empty", now: at(2) });
    expect(await metric("anthropic_refused_at")).toBe(0);
    expect(await metric("anthropic_failed")).toBe(1);
    await recordModelCall(db, { status: 400, ok: false, error: NO_WORKSPACE, now: at(1) });
    expect(await metric("anthropic_refused_at")).toBe(Math.floor(at(1).getTime() / 1000));
    expect(await metric("anthropic_failed")).toBe(2);
  });

  // Production on 15 October 2026: the dead key's last refusal at 12:00:01 UTC on 14 October, no
  // accepted call since, and three items the workspace answer failed at 13:00. The owner sets
  // ANTHROPIC_WORKSPACE_ID and deploys: the next call is accepted, and it brings the three back.
  it("the first accepted call puts back the items the workspace answer failed, and leaves every other failure", async () => {
    const refusedAt = Date.UTC(2026, 9, 14, 12, 0, 1) / 1000;
    expect(refusedAt).toBe(1791979201);
    await setMetric(db, "anthropic_refused_at", refusedAt, "2026-10-14");
    const failedAt = new Date("2026-10-14T13:00:00Z");
    await db.insert(listenItems).values([
      post("t3_ws1", 21, { status: "failed", lastError: NO_WORKSPACE, draftedAt: failedAt }),
      post("t3_ws2", 30, { status: "failed", lastError: NO_WORKSPACE, draftedAt: failedAt }),
      post("t3_ws3", 70, { status: "failed", lastError: NO_WORKSPACE, draftedAt: failedAt }),
      post("t3_other1", 25, { status: "failed", lastError: "messages: text content blocks must be non-empty", draftedAt: failedAt }),
      post("t3_other2", 26, { status: "failed", lastError: "Overloaded", draftedAt: failedAt }),
      post("t3_fresh", 0.5, { status: "new" }),
    ]);
    expect(await metric("anthropic_ok_at")).toBe(0);
    expect((await modelGate(db, NOW)).refused).toBe(true);

    process.env.ANTHROPIC_WORKSPACE_ID = WORKSPACE;
    // The catch-up waits while the refusal is the newest answer; the day's own queue makes the first call.
    const first = await draftPending(db, NOW);
    expect(first).toMatchObject({ drafted: 1, refused: false });
    expect(seen.every((h) => h["anthropic-workspace-id"] === WORKSPACE)).toBe(true);
    const after = await byId();
    for (const id of ["t3_ws1", "t3_ws2", "t3_ws3"]) expect(after[id], id).toEqual({ status: "new", lastError: REQUEUED_ERROR });
    expect(after.t3_other1).toEqual({ status: "failed", lastError: "messages: text content blocks must be non-empty" });
    expect(after.t3_other2).toEqual({ status: "failed", lastError: "Overloaded" });
    expect(after.t3_fresh.status).toBe("drafted");
    const row = (await serviceBoard(db, NOW)).rows.find((r) => r.key === "anthropic")!;
    expect(row.state).not.toBe("alert");

    // The next hour the catch-up drafts the three, oldest first.
    seen = [];
    await draftPending(db, new Date(NOW.getTime() + 3600_000));
    expect(seen).toHaveLength(3);
    expect(Object.fromEntries(Object.entries(await byId()).map(([k, v]) => [k, v.status]))).toMatchObject({ t3_ws1: "drafted", t3_ws2: "drafted", t3_ws3: "drafted", t3_other1: "failed", t3_other2: "failed" });
  });

  // The rule is the restore's own SQL, so these cases run it: no copy of it in code to drift apart.
  it("restoreRefusedItems matches the answer whole, in any case, a dead key's words, and nothing unrelated", async () => {
    await recordModelCall(db, { status: 400, ok: false, error: NO_WORKSPACE, now: at(1) });
    const back = { t3_full: NO_WORKSPACE, t3_upper: NO_WORKSPACE.toUpperCase(), t3_dead: "invalid x-api-key", t3_http401: "HTTP 401" };
    const stays = ["messages: text content blocks must be non-empty", "unparseable answer", "Overloaded", "The operation was aborted due to timeout", "drafting disabled", "", null];
    await db.insert(listenItems).values([
      ...Object.entries(back).map(([id, lastError], i) => post(id, 5 + i, { status: "failed", lastError })),
      ...stays.map((lastError, i) => post(`t3_other${i}`, 10 + i, { status: "failed", lastError })),
    ]);
    expect(await restoreRefusedItems(db, NOW)).toBe(Object.keys(back).length);
    const after = await byId();
    for (const id of Object.keys(back)) expect(after[id], id).toEqual({ status: "new", lastError: REQUEUED_ERROR });
    stays.forEach((lastError, i) => expect(after[`t3_other${i}`], String(lastError)).toEqual({ status: "failed", lastError }));
  });
});

// Every desk that calls the Messages API, each through its own entry: the workspace goes with each
// call once it is set, and no call names one while it is not. The booking screenshot is proven in
// tests/booking-shot.test.ts.
describe("every desk's call names the workspace (db, stubbed network)", () => {
  let db: Db;
  let close: () => Promise<void>;
  let seen: { url: string; headers: Record<string, string> }[] = [];
  /** True: the API answers as it did on 14 October 2026, the 400 of a key with no workspace. */
  let noWorkspace = false;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.TELEGRAM_BOT_TOKEN = "1:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    seen = [];
    noWorkspace = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://api.anthropic.com/v1/messages")) {
          seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
          if (noWorkspace) return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: NO_WORKSPACE } }), { status: 400, headers: { "content-type": "application/json" } });
          return new Response(JSON.stringify({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("api.telegram.org")) return new Response(JSON.stringify({ ok: true, result: { message_id: 900 + seen.length, chat: { id: 777 } } }), { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.ANTHROPIC_WORKSPACE_ID;
  });

  let n = 0;
  /** One call through each desk; each gets a fresh row of its own, so none is skipped as done. */
  const desks: [string, () => Promise<unknown>][] = [
    ["listening drafts", () => draftReply(db, { source: "reddit", url: "https://www.reddit.com/r/padel/comments/d1/x/", title: "Padel app", body: "which app", author: null, postedAt: NOW }, fetch, NOW)],
    [
      "answer pages",
      async () => {
        const [item] = await db.insert(listenItems).values({ source: "reddit", externalId: `t3_ans${++n}`, url: `https://www.reddit.com/r/padel/comments/ans${n}/x/`, title: "Rounds for 8?", body: "americano", postedAt: NOW, status: "approved", draft: "Seven rounds." }).returning();
        return generateAnswer(db, item, NOW, fetch);
      },
    ],
    ["feedback replies", () => composeAck(db, { text: "the court name could be bigger", name: "Ana", locale: "en", source: "web" }, fetch, NOW)],
    [
      "owner proposals",
      async () => {
        const [note] = await db.insert(feedback).values({ source: "web", text: `bigger court names ${++n}`, status: "acknowledged" }).returning();
        return proposeToOwner(db, note.id, fetch, NOW);
      },
    ],
    [
      "press desk drafts",
      async () => {
        const { row } = await recordInbound(db, { emailId: `re_${++n}`, from: "Ana Writer <ana@example.org>", to: ["claude@kicksma.sh"], subject: "A question", text: "Could we talk about the app?", html: null, messageId: `<m${n}@example.org>`, inReplyTo: null }, NOW);
        return draftReplyTo(db, row, NOW, fetch);
      },
    ],
  ];

  it("with ANTHROPIC_WORKSPACE_ID set, every call carries it", async () => {
    process.env.ANTHROPIC_WORKSPACE_ID = WORKSPACE;
    for (const [name, run] of desks) {
      const before = seen.length;
      await run();
      expect(seen.length - before, `${name} made its call`).toBe(1);
      expect(seen[before].headers, name).toEqual({ ...BASE_HEADERS, "anthropic-workspace-id": WORKSPACE });
    }
  });

  it("with it unset, every call carries the three headers it always did", async () => {
    for (const [name, run] of desks) {
      const before = seen.length;
      await run();
      expect(seen.length - before, `${name} made its call`).toBe(1);
      expect(seen[before].headers, name).toEqual(BASE_HEADERS);
    }
  });

  // None of these desks asks modelGate first, so one of them can be the only AI traffic of a day
  // (the listening budget spent, no new item): its refusal alone must turn the board red. Each desk
  // passes the answer's message to recordModelCall; without it, the 400 is an ordinary failure.
  it("the workspace 400 on any desk records a refused key", async () => {
    noWorkspace = true;
    const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(eq(metricsDaily.key, key)))[0]?.value ?? 0);
    for (const [name, run] of desks) {
      await db.delete(metricsDaily);
      const before = seen.length;
      await run();
      expect(seen.length - before, `${name} made its call`).toBe(1);
      expect(await metric("anthropic_refused_at"), name).toBe(Math.floor(NOW.getTime() / 1000));
      expect(await metric("anthropic_failed"), name).toBe(1);
      expect((await modelGate(db, NOW)).refused, name).toBe(true);
    }
  });
});
