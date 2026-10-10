import http, { createServer, type Server } from "node:http";
import https from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { createTranslator } from "next-intl";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import type { Db } from "@/db";
import { clubs, events, notices, players, pushSubscriptions, type Event, type Player } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { createGroup } from "@/lib/domain/groups";
import { joinEvent } from "@/lib/domain/slots";
import { inboxOf, markInboxRead, noticeSettingsOf, pruneNotices, recordNotice, recordNotices, releasesFor } from "@/lib/domain/notices";
import { noticeSummary } from "@/lib/domain/noticeKinds";
import { rolesFor } from "@/lib/domain/roles";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { notifyEventUpdated, notifyGroupMatch, sendQuietSummaries } from "@/lib/notify";
import { notifyLevelCheckAsked } from "@/lib/levelChecks";
import { noticeText } from "@/lib/noticeText";
import en from "../messages/en.json";
import ru from "../messages/ru.json";
import es from "../messages/es.json";
import { createTestDb, DAY, HOUR, makePlayer } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * The owner's decision D, 9 October 2026: "A switch for each notice kind, quiet hours, and an inbox".
 * Real senders on PGlite, mail caught in a file and push answered by a server on this machine, so
 * "nothing was sent" means the code chose not to send it.
 *
 * Hours in Bangkok (UTC+7), where the quiet hours below are set: 22:00–08:00 there is 15:00–01:00 UTC.
 */
const NOW = new Date("2026-10-10T05:00:00.000Z"); // 12:00 in Bangkok
const NIGHT = new Date("2026-10-10T16:30:00.000Z"); // 23:30 in Bangkok
const QUIET = { quietFrom: 22 * 60, quietTo: 8 * 60, quietTz: "Asia/Bangkok" };
freezeClock(NOW);

const b64url = (b: Buffer) => b.toString("base64url");
function fakeSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) };
}

describe("notices: the switch for each kind, quiet hours and the inbox", () => {
  let db: Db;
  let server: Server;
  let port: number;
  let mailDir: string;
  const pushed: string[] = [];
  const mails = () => {
    const f = path.join(mailDir, "mail.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; text: string }) : [];
  };
  let n = 0;
  const person = async (name: string, extra: Partial<Player> = {}, push = true) => {
    const p = await makePlayer(db, name, { email: `${name.toLowerCase()}-${++n}@example.com`, ...extra });
    if (push) await db.insert(pushSubscriptions).values({ playerId: p.id, ...fakeSubscription(`http://127.0.0.1:${port}/push/${name}`) });
    return p;
  };
  const crewMatch = async (org: Player, members: Player[], startsAt = new Date(NOW.getTime() + 2 * DAY)) => {
    const group = await createGroup(db, { name: "Tuesday crew", creatorPlayerId: org.id, tz: "Asia/Bangkok", memberIds: members.map((m) => m.id) });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt, tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    return { group, ev };
  };
  const rowsOf = (playerId: string) => db.select().from(notices).where(eq(notices.playerId, playerId));

  beforeAll(async () => {
    ({ db } = await createTestDb());
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        pushed.push(req.url ?? "");
        res.statusCode = 201;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
    vi.spyOn(https, "request").mockImplementation(((...args: Parameters<typeof http.request>) => http.request(...args)) as typeof https.request);
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
    mailDir = mkdtempSync(path.join(tmpdir(), "notices-"));
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = path.join(mailDir, "mail.jsonl");
  });
  beforeEach(() => {
    pushed.length = 0;
    writeFileSync(path.join(mailDir, "mail.jsonl"), "");
    vi.setSystemTime(NOW);
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    rmSync(mailDir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("keeps the old switch's meaning: a player who turned activity emails off still gets none, and everything else as before", async () => {
    const org = await person("Org", {}, false);
    const old = await person("Old", { emailNotifications: false });
    const fresh = await person("Fresh");
    // What the migration gives every existing player: every kind at its default, no quiet hours.
    expect(await noticeSettingsOf(db, old.id)).toEqual({ kinds: {}, quietFrom: null, quietTo: null, quietTz: null });
    expect(noticeSummary((await noticeSettingsOf(db, old.id))!)).toEqual({ on: 6, total: 7, quiet: null });
    const { group, ev } = await crewMatch(org, [org, old, fresh]);
    const r = await notifyGroupMatch(db, group, ev, org.id);
    // The email switch still stops Old's email; Old's push goes, as it always did, and Fresh gets both.
    expect(r).toEqual({ emails: 1, pushes: 2 });
    expect(mails().map((m) => m.to)).toEqual([fresh.email]);
    expect(pushed.sort()).toEqual(["/push/Fresh", "/push/Old"]);
    for (const p of [old, fresh]) expect((await rowsOf(p.id)).map((x) => [x.kind, x.key, x.deliveredAt?.toISOString()])).toEqual([["crew", "noticeItem.crewMatch", NOW.toISOString()]]);
  });

  it("keeps a switched-off kind in the inbox and never delivers it, not even when quiet hours end", async () => {
    const org = await person("Org2", {}, false);
    const off = await person("Off", { noticeKinds: { crew: false }, ...QUIET });
    const { group, ev } = await crewMatch(org, [org, off]);
    expect(await notifyGroupMatch(db, group, ev, org.id)).toEqual({ emails: 0, pushes: 0 });
    const [row] = await rowsOf(off.id);
    expect(row).toMatchObject({ kind: "crew", deliveredAt: null, dueAt: null });
    expect(await sendQuietSummaries(db, new Date(NOW.getTime() + DAY))).toEqual({ people: 0, messages: 0 });
    expect((await rowsOf(off.id))[0].deliveredAt).toBeNull();
    expect(mails()).toHaveLength(0);
    expect(pushed).toEqual([]);
  });

  it("holds notices through quiet hours, and the hourly job sends one short message per channel when they end", async () => {
    vi.setSystemTime(NIGHT);
    const org = await person("Org3", {}, false);
    const sleeper = await person("Sleeper", QUIET);
    const a = await crewMatch(org, [org, sleeper], new Date(NOW.getTime() + 2 * DAY));
    const b = await crewMatch(org, [org, sleeper], new Date(NOW.getTime() + 3 * DAY));
    await notifyGroupMatch(db, a.group, a.ev, org.id);
    await notifyGroupMatch(db, b.group, b.ev, org.id);
    expect(mails()).toHaveLength(0);
    expect(pushed).toEqual([]);
    const held = await rowsOf(sleeper.id);
    // 08:00 in Bangkok.
    expect(held.map((x) => [x.deliveredAt, x.dueAt?.toISOString()])).toEqual([
      [null, "2026-10-11T01:00:00.000Z"],
      [null, "2026-10-11T01:00:00.000Z"],
    ]);
    // 07:59 in Bangkok: still quiet.
    expect(await sendQuietSummaries(db, new Date("2026-10-11T00:59:00.000Z"))).toEqual({ people: 0, messages: 0 });
    // The first hourly tick after 08:00: one email and one push, for both notices.
    const morning = new Date("2026-10-11T01:05:00.000Z");
    expect(await sendQuietSummaries(db, morning)).toEqual({ people: 1, messages: 2 });
    expect(mails().map((m) => [m.to, m.subject])).toEqual([[sleeper.email, "2 updates while you were away"]]);
    expect(pushed).toEqual(["/push/Sleeper"]);
    expect((await rowsOf(sleeper.id)).map((x) => x.deliveredAt?.toISOString())).toEqual([morning.toISOString(), morning.toISOString()]);
    // Once: the next tick has nothing to say.
    expect(await sendQuietSummaries(db, new Date(morning.getTime() + HOUR))).toEqual({ people: 0, messages: 0 });
  });

  it("lets a change to a match that starts within three hours through quiet hours, and the kind switch still holds it back", async () => {
    vi.setSystemTime(NIGHT);
    const org = await person("Org4", {}, false);
    const awake = await person("Awake", QUIET, false);
    const muted = await person("Muted", { ...QUIET, noticeKinds: { changes: false } }, false);
    // 01:30 in Bangkok: two hours from now.
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NIGHT.getTime() + 2 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    for (const p of [org, awake, muted]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NIGHT });
    await notifyEventUpdated(db, ev);
    // The organiser made the change: their calendar follows it, and their inbox is not told of their own doing.
    expect(mails().map((m) => m.to).sort()).toEqual([awake.email, org.email].sort());
    expect((await rowsOf(awake.id)).map((x) => [x.key, x.deliveredAt?.toISOString()])).toEqual([["noticeItem.matchUpdated", NIGHT.toISOString()]]);
    expect((await rowsOf(muted.id)).map((x) => [x.key, x.deliveredAt, x.dueAt])).toEqual([["noticeItem.matchUpdated", null, null]]);
    expect(await rowsOf(org.id)).toEqual([]);
    // The Telegram note beside the email reads the same gate.
    const released = await releasesFor(db, [awake.id, muted.id], "matchUpdated", { startsAt: ev.startsAt, tz: ev.tz }, NIGHT);
    expect(Object.fromEntries(released)).toEqual({ [awake.id]: "now", [muted.id]: "off" });
  });

  it("writes a fan-out as one insert, however many people it reaches", async () => {
    const org = await person("Org5", {}, false);
    const crew = await Promise.all(["C1", "C2", "C3", "C4", "C5"].map((x) => person(x, {}, false)));
    const { group, ev } = await crewMatch(org, [org, ...crew]);
    const insert = vi.spyOn(db, "insert");
    await notifyGroupMatch(db, group, ev, org.id);
    const intoNotices = insert.mock.calls.filter(([table]) => table === notices).length;
    insert.mockRestore();
    expect(intoNotices).toBe(1);
    expect(await db.select().from(notices).where(eq(notices.eventId, ev.id))).toHaveLength(5);
  });

  it("renders the inbox in the reader's language, from the same rows", async () => {
    const org = await person("Org6", {}, false);
    const ana = await person("Ana", { locale: "ru" }, false);
    const { group, ev } = await crewMatch(org, [org, ana]);
    await notifyGroupMatch(db, group, ev, org.id);
    const { rows, unread } = await inboxOf(db, ana.id);
    expect(unread).toBe(1);
    expect(rows[0].code).toBe(ev.code);
    const read = (locale: "en" | "ru" | "es", messages: object) => noticeText(createTranslator({ locale, messages: messages as never }) as never, locale, rows[0]);
    expect(read("ru", ru)).toBe(`Новый матч в группе Tuesday crew: ${formatEventDay(ev.startsAt, "Asia/Bangkok", "ru")} ${formatEventTime(ev.startsAt, "Asia/Bangkok", "ru")}, Rawai Padel`);
    expect(read("en", en)).toBe(`Tuesday crew has a new match: ${formatEventDay(ev.startsAt, "Asia/Bangkok", "en")} ${formatEventTime(ev.startsAt, "Asia/Bangkok", "en")}, Rawai Padel`);
    expect(read("es", es)).toBe(`Tuesday crew tiene un partido nuevo: ${formatEventDay(ev.startsAt, "Asia/Bangkok", "es")} ${formatEventTime(ev.startsAt, "Asia/Bangkok", "es")}, Rawai Padel`);
    // The header's count, and opening the inbox reads it.
    expect((await rolesFor(db, ana.id)).unread).toBe(1);
    expect(await markInboxRead(db, ana.id)).toBe(1);
    expect((await rolesFor(db, ana.id)).unread).toBe(0);
  });

  it("prunes notices older than ninety days, a bounded batch at a time", async () => {
    const p = await person("Pruned", {}, false);
    const row = (days: number) => ({ playerId: p.id, kind: "crew" as const, key: "noticeItem.crewMatch", params: {}, createdAt: new Date(NOW.getTime() - days * DAY) });
    await db.insert(notices).values([row(91), row(95), row(89)]);
    expect(await pruneNotices(db, NOW, 1)).toBe(1);
    expect(await pruneNotices(db, NOW)).toBe(1);
    expect(await pruneNotices(db, NOW)).toBe(0);
    expect((await rowsOf(p.id)).map((x) => Math.round((NOW.getTime() - x.createdAt.getTime()) / DAY))).toEqual([89]);
  });

  it("keeps no token and no personal link in any notice row", async () => {
    const org = await person("Org7", {}, false);
    const bea = await person("Bea", {}, false);
    const { group, ev } = await crewMatch(org, [org, bea]);
    for (const p of [org, bea]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    await notifyGroupMatch(db, group, ev, org.id);
    await notifyEventUpdated(db, ev);
    // A club's level check: the answer's door carries the club's manage token, on the channel only.
    const [club] = await db.insert(clubs).values({ slug: "token-club", name: "Token Club", claimedBy: org.id, manageToken: "MANAGE-TOKEN-SECRET-1", approvedAt: NOW, source: "claim" } as never).returning();
    await notifyLevelCheckAsked(db, { id: "00000000-0000-0000-0000-000000000001", clubSlug: club.slug, coachId: null, level: 3.5 } as never, bea);
    // Whoever passes a link, the row drops it.
    await recordNotice(db, { playerId: bea.id, sender: "spotOpen", params: { venue: `https://kicksma.sh/p/${"x".repeat(20)}/${ev.code}`, name: "/p/abc" } });

    const secrets = [
      ...(await db.select({ t: players.personalToken }).from(players).where(isNotNull(players.personalToken))).map((r) => r.t!),
      ...(await db.select({ t: events.manageCode }).from(events).where(isNotNull(events.manageCode))).map((r) => r.t!),
      "MANAGE-TOKEN-SECRET-1",
    ];
    expect(secrets.length).toBeGreaterThan(2);
    const all = await db.select().from(notices);
    expect(all.length).toBeGreaterThan(4);
    for (const r of all) {
      const text = JSON.stringify(r);
      expect(text, r.key).not.toMatch(/:\/\/|\/p\//);
      for (const s of secrets) expect(text.includes(s), r.key).toBe(false);
    }
  });

  it("records the batch's answer for each person, and a person with no row is not invented", async () => {
    const p = await person("Batch", { noticeKinds: { spots: false } }, false);
    const q = await person("Batch2", {}, false);
    const r = await recordNotices(db, [
      { playerId: p.id, sender: "spotOpen" },
      { playerId: q.id, sender: "spotOpen" },
      { playerId: "00000000-0000-0000-0000-00000000dead", sender: "spotOpen" },
    ]);
    expect(Object.fromEntries(r)).toEqual({ [p.id]: "off", [q.id]: "now" });
    expect(await db.select().from(notices).where(and(eq(notices.key, "noticeItem.spotOpen"), inArray(notices.playerId, [p.id, q.id])))).toHaveLength(2);
    expect(await db.select().from(notices).where(eq(notices.playerId, "00000000-0000-0000-0000-00000000dead"))).toEqual([]);
  });
});

export type { Event };
