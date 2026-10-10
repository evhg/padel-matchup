import http, { createServer, type Server } from "node:http";
import https from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import type { Db } from "@/db";
import { eq } from "drizzle-orm";
import { notices, players, pushSubscriptions } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { joinEvent } from "@/lib/domain/slots";
import { mayEmailClubMatch, notifyClubMatch } from "@/lib/notify";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";
import { freezeClock } from "./helpers/clock";

/**
 * A club's weekly programme makes a match, and the club's recent players may hear about it. They did
 * not ask to, so the email stopped on 9 October 2026 (decision B), and decision D made the whole
 * notice one kind, "club matches", off by default: everybody it is for finds it in their inbox, and
 * only a player who switched it on hears it, by push and (with activity emails on) by email.
 */
const NOW = new Date("2026-10-09T03:00:00.000Z");
freezeClock(NOW);

const b64url = (b: Buffer) => b.toString("base64url");
/** A browser's subscription, with real keys, since web-push encrypts for them. */
function fakeSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) };
}

describe("the club programme's notice", () => {
  let db: Db;
  let close: () => Promise<void>;
  let server: Server;
  let port: number;
  let mailDir: string;
  const pushed: string[] = [];
  const mails = () => {
    const f = path.join(mailDir, "mail.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string }) : [];
  };

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    // A push service on this machine: web-push always speaks TLS, so its requests are routed here in plain HTTP.
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
    // Email is on, with every message caught in a file, so "no email" means the code chose not to send one.
    mailDir = mkdtempSync(path.join(tmpdir(), "club-notice-"));
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = path.join(mailDir, "mail.jsonl");
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    rmSync(mailDir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
    await close();
  });

  it("asks nobody for the email by default, and a player who switched club matches on", () => {
    expect(mayEmailClubMatch({ noticeKinds: {} })).toBe(false);
    expect(mayEmailClubMatch({ noticeKinds: { clubMatches: true } })).toBe(true);
  });

  it("by default tells a recent player of the club nothing, and keeps it in their inbox", async () => {
    const club = await makePlayer(db, "Club desk");
    const ana = await makePlayer(db, "Ana", { email: "ana@example.com", emailNotifications: true });
    const sub = fakeSubscription(`http://127.0.0.1:${port}/push/ana`);
    await db.insert(pushSubscriptions).values({ playerId: ana.id, ...sub });
    // Ana has a match at the club this afternoon, which is what puts her in the audience.
    const today = await createEvent(db, { creatorPlayerId: club.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    await joinEvent(db, { eventId: today.id, playerId: ana.id, now: NOW });
    // The programme's new match, at the same club.
    const next = await createEvent(db, { creatorPlayerId: club.id, type: "match", startsAt: new Date(NOW.getTime() + 30 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    expect(next.venueSlug).toBe(today.venueSlug);

    const r = await notifyClubMatch(db, { slug: next.venueSlug!, name: "Rawai Padel" }, next, NOW);
    expect(r).toEqual({ emails: 0, pushes: 0, told: 0 });
    expect(pushed).toEqual([]);
    expect(mails()).toHaveLength(0);
    const kept = await db.select().from(notices).where(eq(notices.playerId, ana.id));
    expect(kept.map((n) => [n.kind, n.key, n.deliveredAt])).toEqual([["clubMatches", "noticeItem.clubMatch", null]]);

    // Switched on: the push and the email both go, and the row says it was delivered.
    await db.update(players).set({ noticeKinds: { clubMatches: true } }).where(eq(players.id, ana.id));
    const again = await createEvent(db, { creatorPlayerId: club.id, type: "match", startsAt: new Date(NOW.getTime() + 54 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    const r2 = await notifyClubMatch(db, { slug: again.venueSlug!, name: "Rawai Padel" }, again, NOW);
    expect(r2).toEqual({ emails: 1, pushes: 1, told: 1 });
    expect(pushed).toEqual(["/push/ana"]);
    expect(mails().map((m) => m.to)).toEqual(["ana@example.com"]);
  });
});
