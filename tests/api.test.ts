import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { webhookDeliveries } from "@/db/schema";
import { authenticate, createApiKey, generateKey, hashKey } from "@/lib/api/keys";
import { handleMcpPost } from "@/lib/api/mcp";
import { openapiDocument } from "@/lib/api/openapi";
import { createMatch, generateSchedule, joinMatch, NO_SIDE_EFFECTS } from "@/lib/api/operations";
import { matchToPublic } from "@/lib/api/serialize";
import { createWebhook, dispatch, processWebhookRetries, sign, verifySignature } from "@/lib/api/webhooks";
import { buildFeed } from "@/lib/calendar";
import { createEvent } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

const soon = () => new Date(Date.now() + 26 * HOUR).toISOString();

describe("keys", () => {
  it("generates ks_live_ keys, stores only the hash, authenticates bearer headers", async () => {
    const g = generateKey();
    expect(g.key.startsWith("ks_live_")).toBe(true);
    expect(g.hash).toBe(hashKey(g.key));
    const { key, record } = await createApiKey(db, { name: "Test bot", agent: "vitest" });
    expect(record.keyHash).not.toContain(key.slice(10));
    const auth = await authenticate(db, new Request("http://x", { headers: { authorization: `Bearer ${key}` } }));
    expect(auth?.id).toBe(record.id);
    expect(await authenticate(db, new Request("http://x"))).toBeNull();
    await expect(authenticate(db, new Request("http://x", { headers: { authorization: "Bearer ks_live_nope" } }))).rejects.toMatchObject({ status: 401 });
    await expect(authenticate(db, new Request("http://x", { headers: { authorization: "Bearer sk_other" } }))).rejects.toMatchObject({ code: "invalid_key" });
  });
});

describe("public shapes", () => {
  it("expose first names and levels, never emails, phones, tokens or manage codes", async () => {
    const org = await makePlayer(db, "Ana", { email: "ana@secret.io", phone: "+6599999999", personalToken: "tok_secret_123", level: 3.5 });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "Asia/Singapore", venueName: "Club Nine", whenFull: "waitlist", levelMin: 3, levelMax: 4.5, bookingUrl: "https://example.com/b/1" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    const detail = (await getEventByCode(db, ev.code))!;
    const pub = matchToPublic(detail, "https://kicksma.sh", null);
    const text = JSON.stringify(pub);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("+65");
    expect(text).not.toContain(ev.manageCode);
    expect(pub.players[0]).toMatchObject({ name: "Ana", level: 3.5, organizer: true });
    expect(pub.level).toEqual({ min: 3, max: 4.5, preset: "gold" });
    expect(pub.venue?.slug).toBe("club-nine");
    expect(pub.bookingUrl).toBe("https://example.com/b/1");
    expect(pub.spotsLeft).toBe(3);
  });
});

describe("operations", () => {
  it("createMatch: validates, creates the organizer, returns links; joinMatch handles levels and tokens", async () => {
    const r = await createMatch(db, { startsAt: "2026-09-11T19:00", tz: "Asia/Singapore", venue: "Club Nine", organizer: { name: "Ana", level: 3.5 }, levelMin: 3, levelMax: 4.5, listOnVenueBoard: true }, NO_SIDE_EFFECTS);
    expect(r.match.players).toHaveLength(1);
    expect(r.match.listed).toBe(true);
    expect(r.organizer.personalToken).toHaveLength(12);
    expect(r.organizer.manageUrl).toContain("/manage/");
    // startsAt without offset is read in tz: 19:00 Singapore = 11:00Z
    expect(r.match.startsAt).toBe("2026-09-11T11:00:00.000Z");

    await expect(createMatch(db, { startsAt: soon(), tz: "Mars/Olympus", organizer: { name: "X" } }, NO_SIDE_EFFECTS)).rejects.toMatchObject({ status: 422 });
    await expect(createMatch(db, { startsAt: "not a date", tz: "UTC", organizer: { name: "X" } }, NO_SIDE_EFFECTS)).rejects.toMatchObject({ code: "invalid_request" });

    const bo = await joinMatch(db, { code: r.match.code, name: "Bo", level: 3.25 }, NO_SIDE_EFFECTS);
    expect(bo.outcome).toBe("joined");
    expect(bo.match.players).toHaveLength(2);
    await expect(joinMatch(db, { code: r.match.code, name: "Cy" }, NO_SIDE_EFFECTS)).rejects.toMatchObject({ code: "level_required" });
    const dee = await joinMatch(db, { code: r.match.code, name: "Dee", level: 5.5 }, NO_SIDE_EFFECTS);
    expect(dee.outcome).toBe("requested");
    const again = await joinMatch(db, { code: r.match.code, token: bo.player.personalToken }, NO_SIDE_EFFECTS);
    expect(again.outcome).toBe("already_in");
    await expect(joinMatch(db, { code: "ZZZZ", name: "Nobody" }, NO_SIDE_EFFECTS)).rejects.toMatchObject({ status: 404 });
    await expect(joinMatch(db, { code: r.match.code, token: "unknown-token-xyz" }, NO_SIDE_EFFECTS)).rejects.toMatchObject({ code: "unknown_token" });
  });
  it("generateSchedule: exact rotation in fours, fair sit-outs otherwise, names honoured", () => {
    const eight = generateSchedule({ players: 8 });
    expect(eight.rounds).toHaveLength(7);
    expect(eight.exact).toBe(true);
    const named = generateSchedule({ names: ["Ana", "Bo", "Cy", "Di", "Ed"] });
    expect(named.players).toBe(5);
    expect(named.courts).toBe(1);
    expect(named.rounds.every((r) => r.resting.length === 1)).toBe(true);
    const rests = named.rounds.map((r) => r.resting[0]);
    expect(new Set(rests).size).toBe(5);
    expect(() => generateSchedule({ players: 3 })).toThrow();
  });
});

describe("MCP handler", () => {
  it("initialize, tools/list, tools/call, resources, notifications and errors", async () => {
    const init = await handleMcpPost(db, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }, NO_SIDE_EFFECTS);
    expect(init.status).toBe(200);
    expect((init.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-03-26");
    const old = await handleMcpPost(db, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } }, NO_SIDE_EFFECTS);
    expect((old.body as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    const notif = await handleMcpPost(db, { jsonrpc: "2.0", method: "notifications/initialized" }, NO_SIDE_EFFECTS);
    expect(notif).toEqual({ status: 202, body: null });
    const list = await handleMcpPost(db, { jsonrpc: "2.0", id: 2, method: "tools/list" }, NO_SIDE_EFFECTS);
    const tools = (list.body as { result: { tools: { name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }[] } }).result.tools;
    expect(tools.map((t) => t.name)).toEqual(["about_kicksmash", "get_match", "find_matches", "get_group", "generate_schedule", "create_match", "join_match", "create_api_key"]);
    expect(tools.find((t) => t.name === "create_match")!.annotations.readOnlyHint).toBe(false);
    const sched = await handleMcpPost(db, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "generate_schedule", arguments: { players: 12, courts: 3 } } }, NO_SIDE_EFFECTS);
    expect((sched.body as { result: { structuredContent: { rounds: unknown[] } } }).result.structuredContent.rounds).toHaveLength(11);
    const created = await handleMcpPost(db, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "create_match", arguments: { startsAt: soon(), tz: "Asia/Bangkok", organizer: { name: "Ivan" } } } }, NO_SIDE_EFFECTS);
    const code = (created.body as { result: { structuredContent: { match: { code: string } } } }).result.structuredContent.match.code;
    expect(code).toHaveLength(4);
    const bad = await handleMcpPost(db, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "get_match", arguments: { code: "ZZZZ" } } }, NO_SIDE_EFFECTS);
    expect((bad.body as { result: { isError: boolean; content: { text: string }[] } }).result.isError).toBe(true);
    const badArgs = await handleMcpPost(db, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "join_match", arguments: { code: "TOO-LONG-CODE" } } }, NO_SIDE_EFFECTS);
    expect((badArgs.body as { result: { isError: boolean; content: { text: string }[] } }).result.content[0].text).toMatch(/Invalid arguments/);
    const unknownTool = await handleMcpPost(db, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "nope" } }, NO_SIDE_EFFECTS);
    expect((unknownTool.body as { error: { code: number } }).error.code).toBe(-32602);
    const unknown = await handleMcpPost(db, { jsonrpc: "2.0", id: 8, method: "what/ever" }, NO_SIDE_EFFECTS);
    expect((unknown.body as { error: { code: number } }).error.code).toBe(-32601);
    const batch = await handleMcpPost(db, [{ jsonrpc: "2.0", id: 9, method: "ping" }, { jsonrpc: "2.0", method: "notifications/x" }], NO_SIDE_EFFECTS);
    expect(Array.isArray(batch.body) && (batch.body as unknown[]).length === 1).toBe(true);
    const res = await handleMcpPost(db, { jsonrpc: "2.0", id: 10, method: "resources/read", params: { uri: "kicksmash://docs/openapi" } }, NO_SIDE_EFFECTS);
    expect(JSON.parse((res.body as { result: { contents: { text: string }[] } }).result.contents[0].text).openapi).toBe("3.1.0");
    expect((await handleMcpPost(db, { nope: true }, NO_SIDE_EFFECTS)).status).toBe(200);
  });
});

describe("OpenAPI", () => {
  it("is a 3.1 document whose schemas come from the same zod shapes", () => {
    const doc = openapiDocument("https://kicksma.sh");
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain("/api/v1/matches/{code}/join");
    const cm = doc.components.schemas.CreateMatch as { properties: Record<string, unknown>; required?: string[] };
    expect(cm.properties.organizer).toBeDefined();
    expect(cm.required).toContain("startsAt");
    expect(JSON.stringify(doc)).not.toContain("$schema");
  });
});

describe("webhooks", () => {
  it("signs, delivers, records, retries with backoff and verifies", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    let status = 200;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: String(init.body) });
      return new Response("ok", { status });
    }));
    const { record } = await createApiKey(db, { name: "hooks" });
    const { webhook, secret } = await createWebhook(db, record.id, { url: "https://example.com/hook", events: ["match.created", "match.joined"], filter: { venueSlug: "club-nine" } });
    await expect(createWebhook(db, record.id, { url: "ftp://nope" })).rejects.toMatchObject({ status: 422 });
    await expect(createWebhook(db, record.id, { url: "https://x.y", events: ["not.an.event"] })).rejects.toMatchObject({ status: 422 });

    const org = await makePlayer(db, "Hook Org");
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", venueName: "Club Nine", whenFull: "waitlist" });
    const pub = matchToPublic((await getEventByCode(db, ev.code))!, "https://kicksma.sh", null);
    expect(await dispatch(db, "match.created", pub)).toBe(1);
    expect(await dispatch(db, "match.cancelled", pub)).toBe(0); // not subscribed
    const elsewhere = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + HOUR), tz: "UTC", venueName: "Other", whenFull: "waitlist" });
    expect(await dispatch(db, "match.created", matchToPublic((await getEventByCode(db, elsewhere.code))!, "https://kicksma.sh", null))).toBe(0); // filtered out
    expect(calls).toHaveLength(1);
    const sigHeader = calls[0].headers["X-Kicksmash-Signature"];
    expect(verifySignature(secret, sigHeader, calls[0].body)).toBe(true);
    expect(verifySignature(secret, sigHeader, calls[0].body + "x")).toBe(false);
    expect(verifySignature("whsec_wrong", sigHeader, calls[0].body)).toBe(false);
    const parsed = JSON.parse(calls[0].body);
    expect(parsed.event).toBe("match.created");
    expect(parsed.data.match.code).toBe(ev.code);
    const ts = Number(/t=(\d+)/.exec(sigHeader)![1]);
    expect(sign(secret, ts, calls[0].body)).toBe(sigHeader);

    // failure → scheduled retry → success on retry
    status = 500;
    expect(await dispatch(db, "match.joined", pub)).toBe(0);
    const [pending] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.event, "match.joined"));
    expect(pending.attempts).toBe(1);
    expect(pending.deliveredAt).toBeNull();
    expect(pending.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    status = 200;
    const notYet = await processWebhookRetries(db, new Date());
    expect(notYet.attempted).toBe(0);
    const later = await processWebhookRetries(db, new Date(Date.now() + 2 * 60_000));
    expect(later).toEqual({ attempted: 1, delivered: 1 });
    const [done] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, pending.id));
    expect(done.deliveredAt).not.toBeNull();
    expect(done.attempts).toBe(2);
    void webhook;
  });
});

describe("calendar feed", () => {
  it("builds a PUBLISH calendar with one VEVENT per match", () => {
    const now = new Date("2026-09-10T11:00:00Z");
    const ev = { id: "11111111-1111-1111-1111-111111111111", code: "AB12", title: "Thursday padel", startsAt: now, venueName: "Club Nine", venueMapUrl: null, court: null, note: null, type: "match" as const, icsSequence: 2, status: "open" as const };
    const ics = buildFeed({ name: "Thursday crew", domain: "kicksma.sh", entries: [{ event: ev, title: "Thursday padel", url: "https://kicksma.sh/AB12" }, { event: { ...ev, id: "22222222-2222-2222-2222-222222222222", status: "cancelled" as const }, title: "Old one", url: "https://kicksma.sh/CD34" }] });
    expect(ics).toContain("METHOD:PUBLISH");
    expect(ics).toContain("X-WR-CALNAME:Thursday crew");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("SEQUENCE:2");
    expect(ics).toContain("STATUS:CANCELLED");
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
