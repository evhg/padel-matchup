import http, { createServer, type Server } from "node:http";
import https from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { players } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { findPlayerByPersonalToken, getOrCreatePersonalToken, rotatePersonalToken, TOKEN_LENGTH } from "@/lib/domain/identity";
import { findPushRemindersDue, isPushReminderDue, markPushReminded, playerHasPush, PUSH_REMINDER_LEAD_MS, removePushSubscription, savePushSubscription, subscriptionsFor } from "@/lib/domain/push";
import { createTestDb, HOUR, makePlayer } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

const b64url = (b: Buffer) => b.toString("base64url");
function fakeSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) } };
}

describe("push subscriptions", () => {
  it("upserts by endpoint, lists per player, removes", async () => {
    const p = await makePlayer(db, "Push");
    const sub = fakeSubscription("https://push.example/one");
    expect(await playerHasPush(db, p.id)).toBe(false);
    await savePushSubscription(db, p.id, sub, "UA");
    await savePushSubscription(db, p.id, { ...sub, keys: { ...sub.keys, auth: "changed" } }, "UA2");
    const rows = await subscriptionsFor(db, [p.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].auth).toBe("changed");
    expect(await playerHasPush(db, p.id)).toBe(true);
    await removePushSubscription(db, sub.endpoint);
    expect(await playerHasPush(db, p.id)).toBe(false);
  });
});

describe("reminder window", () => {
  const base = { status: "open" as const, pushReminderSentAt: null };
  const now = new Date("2026-09-04T10:00:00Z");
  it("is due only inside the last hour, once, for live events", () => {
    expect(isPushReminderDue({ ...base, startsAt: new Date(now.getTime() + 59 * 60 * 1000) }, now)).toBe(true);
    expect(isPushReminderDue({ ...base, startsAt: new Date(now.getTime() + PUSH_REMINDER_LEAD_MS) }, now)).toBe(true);
    expect(isPushReminderDue({ ...base, startsAt: new Date(now.getTime() + 61 * 60 * 1000) }, now)).toBe(false);
    expect(isPushReminderDue({ ...base, startsAt: new Date(now.getTime() - 60 * 1000) }, now)).toBe(false);
    expect(isPushReminderDue({ ...base, startsAt: new Date(now.getTime() + 30 * 60 * 1000), pushReminderSentAt: now }, now)).toBe(false);
    expect(isPushReminderDue({ ...base, status: "cancelled", startsAt: new Date(now.getTime() + 30 * 60 * 1000) }, now)).toBe(false);
  });
  it("finds due events and claims each exactly once", async () => {
    const org = await makePlayer(db, "Org");
    const soon = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + 40 * 60 * 1000), tz: "UTC", whenFull: "waitlist" });
    await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + 3 * HOUR), tz: "UTC", whenFull: "waitlist" });
    const due = await findPushRemindersDue(db);
    expect(due.map((e) => e.id)).toEqual([soon.id]);
    expect(await markPushReminded(db, soon.id)).toBe(true);
    expect(await markPushReminded(db, soon.id)).toBe(false);
    expect(await findPushRemindersDue(db)).toHaveLength(0);
  });
});

describe("sending", () => {
  let server: Server;
  let port: number;
  const received: { path: string; headers: Record<string, string | string[] | undefined>; bytes: number }[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let n = 0;
      req.on("data", (c: Buffer) => (n += c.length));
      req.on("end", () => {
        received.push({ path: req.url ?? "", headers: req.headers, bytes: n });
        res.statusCode = req.url?.endsWith("/gone") ? 410 : 201;
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
    // web-push always speaks TLS; route it to the plain local server.
    vi.spyOn(https, "request").mockImplementation(((...args: Parameters<typeof http.request>) => http.request(...args)) as typeof https.request);
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = "mailto:test@example.com";
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("delivers an encrypted VAPID request and reports dropped subscriptions", async () => {
    const { sendPush, pushEnabled } = await import("@/lib/push");
    expect(pushEnabled()).toBe(true);
    const ok = fakeSubscription(`http://127.0.0.1:${port}/push/ok`);
    const gone = fakeSubscription(`http://127.0.0.1:${port}/push/gone`);
    const payload = { title: "🎾 Padel in 1 hour · 18:00", body: "Club · Court 3", url: "https://kicksma.sh/p/abc/PLAY" };
    expect(await sendPush({ endpoint: ok.endpoint, p256dh: ok.keys.p256dh, auth: ok.keys.auth }, payload)).toBe("sent");
    expect(await sendPush({ endpoint: gone.endpoint, p256dh: gone.keys.p256dh, auth: gone.keys.auth }, payload)).toBe("gone");
    expect(received).toHaveLength(2);
    const first = received[0];
    expect(first.path).toBe("/push/ok");
    expect(String(first.headers["content-encoding"])).toBe("aes128gcm");
    expect(String(first.headers.authorization)).toMatch(/^vapid t=.+k=.+/);
    expect(first.bytes).toBeGreaterThan(JSON.stringify(payload).length);
  });
});

describe("short personal tokens", () => {
  it("issues 12-char tokens and shortens legacy 32-char ones while keeping them valid", async () => {
    const fresh = await makePlayer(db, "Fresh");
    expect(await getOrCreatePersonalToken(db, fresh.id)).toHaveLength(TOKEN_LENGTH);

    const legacyToken = "AbCdEfGhJkLmNpQrStUvWxYzAbCdEfGh";
    const legacy = await makePlayer(db, "Legacy", { personalToken: legacyToken });
    const short = await getOrCreatePersonalToken(db, legacy.id);
    expect(short).toHaveLength(TOKEN_LENGTH);
    expect(await getOrCreatePersonalToken(db, legacy.id)).toBe(short);
    expect((await findPlayerByPersonalToken(db, legacyToken))?.id).toBe(legacy.id);
    expect((await findPlayerByPersonalToken(db, short))?.id).toBe(legacy.id);

    // A user-requested reset invalidates both.
    const reset = await rotatePersonalToken(db, legacy.id);
    expect(await findPlayerByPersonalToken(db, legacyToken)).toBeNull();
    expect(await findPlayerByPersonalToken(db, short)).toBeNull();
    expect((await findPlayerByPersonalToken(db, reset))?.id).toBe(legacy.id);
    const [row] = await db.select({ prev: players.previousToken }).from(players).where(eq(players.id, legacy.id));
    expect(row.prev).toBeNull();
  });
});
