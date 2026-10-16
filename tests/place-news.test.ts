import http, { createServer, type Server } from "node:http";
import https from "node:https";
import { createECDH, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { notices, players, pushSubscriptions, type LevelCheck, type Player } from "@/db/schema";
import { afterLeave } from "@/lib/aftermath";
import { recordMark } from "@/lib/domain/emailMarks";
import { createEvent } from "@/lib/domain/events";
import { createJoinRequest, decideJoinRequest } from "@/lib/domain/requests";
import { joinEvent, leaveEvent } from "@/lib/domain/slots";
import { admitConfirmed, confirmLevel } from "@/lib/domain/verify";
import { announceAdmission, notifyLevelCheckDecided } from "@/lib/levelChecks";
import { notifyRequestDecided } from "@/lib/notify";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * The owner's decision of 16 October 2026 (D5). The question: "A player who asked to join, or waits on the
 * waiting list, gets no "Stay updated" card, and their answer or move-up goes by email only. What should
 * Kicksmash do?" The answer: "Card and all channels (Recommended)": "Show the card to them, and send the
 * answer and the move-up on every channel they gave (Telegram, WhatsApp, push, email). Pro: a player who
 * moves up knows they have a place."
 *
 * As a line-up's notice does (`tellTheRest`): the email of its own (the invitation, the kind no) where
 * the address works, and through `tell()` on the channel the player gave for everybody it did not reach,
 * so a Telegram-only, WhatsApp-only or push-only player hears it, and each player hears it once. The
 * inbox row and its gate come first, so a kind switched off or quiet hours hold it (DECIDING rule 33).
 * Every channel is stubbed here: Telegram and WhatsApp at `fetch`, push at a push service on this machine,
 * email in a file.
 */
const NOW = new Date(Date.UTC(2026, 9, 16, 4, 0));
freezeClock(NOW);

const b64url = (b: Buffer) => b.toString("base64url");
/** A browser's subscription, with real keys, since web-push encrypts for them. */
function fakeSubscription(endpoint: string) {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { endpoint, p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) };
}

describe("the answer to a join request and the move up reach the player on the channel they gave, once", () => {
  let db: Db;
  let close: () => Promise<void>;
  let server: Server;
  let port: number;
  let mailDir: string;
  /** What each channel delivered, by whom it reached: a Telegram chat id, a WhatsApp number, a push endpoint's path, an address. */
  let telegram: { chat: string; text: string }[] = [];
  let whatsapp: { to: string; template: string }[] = [];
  let pushed: string[] = [];
  const mails = (to: string) => {
    const f = path.join(mailDir, "mail.jsonl");
    return (existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; ics: { method: string } | null }) : []).filter((m) => m.to === to);
  };
  /** Everything one player received, on every channel. */
  const heard = (p: Player, endpoint?: string) => ({
    telegram: telegram.filter((m) => p.telegramId != null && m.chat === String(p.telegramId)).length,
    whatsapp: whatsapp.filter((m) => p.phone && m.to === p.phone.replace(/\D/g, "")).length,
    push: pushed.filter((u) => endpoint && u === endpoint).length,
    email: p.email ? mails(p.email).length : 0,
  });

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
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
    process.env.TELEGRAM_BOT_TOKEN = "123:news";
    process.env.WHATSAPP_TOKEN = "wa-news";
    process.env.WHATSAPP_PHONE_ID = "100";
    mailDir = mkdtempSync(path.join(tmpdir(), "place-news-"));
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = path.join(mailDir, "mail.jsonl");
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string | number; text?: string; to?: string; type?: string; template?: { name: string } };
      if (u.includes("graph.facebook.com")) {
        if (body.type === "template" && body.template) whatsapp.push({ to: String(body.to), template: body.template.name });
        return new Response(JSON.stringify({ messages: [{ id: "wamid.news" }] }), { status: 200 });
      }
      if (u.includes("api.telegram.org") && u.endsWith("/sendMessage")) telegram.push({ chat: String(body.chat_id), text: String(body.text ?? "") });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), { status: 200, headers: { "content-type": "application/json" } });
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    rmSync(mailDir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
    await close();
  });
  beforeEach(() => {
    telegram = [];
    whatsapp = [];
    pushed = [];
  });

  let n = 0;
  /** A match of four, its organiser seated, `others` seated after. */
  const match = async (others: Player[] = []) => {
    const org = await makePlayer(db, `Org ${++n}`, { email: `org-news-${n}@example.com` });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    for (const p of [org, ...others]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: NOW });
    return { org, ev };
  };
  const pushOnly = async (name: string) => {
    const p = await makePlayer(db, name);
    const endpoint = `/push-${name.replace(/\W/g, "")}-${n}`;
    await db.insert(pushSubscriptions).values({ playerId: p.id, ...fakeSubscription(`https://127.0.0.1:${port}${endpoint}`) });
    return { p, endpoint };
  };
  /** The organiser decides an ask as the action does: the domain's decision, then the notice. */
  const decide = async (ev: { id: string }, org: Player, p: Player, approve: boolean) => {
    const req = await createJoinRequest(db, { eventId: ev.id, playerId: p.id, level: null, now: NOW });
    const res = await decideJoinRequest(db, { eventId: ev.id, requestId: req.id, approve, actorPlayerId: org.id });
    const news = !approve ? "declined" : res.join?.outcome === "waitlisted" ? "waitlisted" : "joined";
    await notifyRequestDecided(db, res.event, p, news);
    return news;
  };

  it("an approval reaches a Telegram-only player, on Telegram, once", async () => {
    const tola = await makePlayer(db, "Tola", { telegramId: 7_100_001 });
    const { org, ev } = await match();
    expect(await decide(ev, org, tola, true)).toBe("joined");
    expect(heard(tola)).toEqual({ telegram: 1, whatsapp: 0, push: 0, email: 0 });
    expect(telegram[0].text).toContain("You're in");
  });

  it("a yes on a full match, a place on the waiting list, reaches a WhatsApp-only player as a template; a no reaches a push-only player", async () => {
    const wan = await makePlayer(db, "Wan", { phone: "+66 81 000 0001" });
    const { org, ev } = await match([await makePlayer(db, "A1"), await makePlayer(db, "A2"), await makePlayer(db, "A3")]);
    expect(await decide(ev, org, wan, true)).toBe("waitlisted");
    expect(heard(wan)).toEqual({ telegram: 0, whatsapp: 1, push: 0, email: 0 });
    expect(whatsapp[0].template).toBe("ks_match_update");
    const { p: pia, endpoint } = await pushOnly("Pia");
    const { org: org2, ev: ev2 } = await match();
    expect(await decide(ev2, org2, pia, false)).toBe("declined");
    expect(heard(pia, endpoint)).toEqual({ telegram: 0, whatsapp: 0, push: 1, email: 0 });
  });

  it("a move up reaches a push-only player once, and the line-up notice leaves them out", async () => {
    const leaver = await makePlayer(db, "Lev", { email: "lev-news@example.com" });
    const { p: seated, endpoint: seatedAt } = await pushOnly("Sid");
    const { ev } = await match([leaver, seated, await makePlayer(db, "B3")]);
    const { p: wes, endpoint } = await pushOnly("Wes");
    expect((await joinEvent(db, { eventId: ev.id, playerId: wes.id, now: NOW })).outcome).toBe("waitlisted");
    const res = await leaveEvent(db, { eventId: ev.id, playerId: leaver.id, now: NOW });
    expect(res.promotion?.playerId).toBe(wes.id);
    // Read as if the line-up was not complete before, so the line-up notice goes round as well: the
    // players already seated hear it, and the player who moved up hears the move up alone.
    await afterLeave(db, res, leaver, { wasComplete: false, code: ev.code });
    expect(heard(seated, seatedAt)).toEqual({ telegram: 0, whatsapp: 0, push: 1, email: 0 });
    expect(heard(wes, endpoint)).toEqual({ telegram: 0, whatsapp: 0, push: 1, email: 0 });
    // Its inbox holds the move up, once, and no line-up notice.
    expect((await db.select().from(notices).where(eq(notices.playerId, wes.id))).map((r) => r.key)).toEqual(["noticeItem.movedUp"]);
    expect((await db.select().from(notices).where(eq(notices.playerId, seated.id))).map((r) => r.key)).toEqual(["noticeItem.lineupComplete"]);
  });

  it("nobody hears twice: a player with an address and Telegram gets the invitation by email and nothing more; with an address alone, the email alone", async () => {
    const dual = await makePlayer(db, "Dual", { email: "dual-news@example.com", telegramId: 7_100_002 });
    const { org, ev } = await match();
    await decide(ev, org, dual, true);
    expect(heard(dual)).toEqual({ telegram: 0, whatsapp: 0, push: 0, email: 1 });
    expect(mails("dual-news@example.com")[0].ics?.method).toBe("REQUEST");
    // The move up, the same: one invitation, nothing on Telegram.
    const leaver = await makePlayer(db, "Lev2");
    const { ev: ev2 } = await match([leaver, await makePlayer(db, "C2"), await makePlayer(db, "C3")]);
    const mo = await makePlayer(db, "Mo", { email: "mo-news@example.com", telegramId: 7_100_003 });
    await joinEvent(db, { eventId: ev2.id, playerId: mo.id, now: NOW });
    const res = await leaveEvent(db, { eventId: ev2.id, playerId: leaver.id, now: NOW });
    await afterLeave(db, res, leaver, { wasComplete: true, code: ev2.code });
    expect(heard(mo)).toEqual({ telegram: 0, whatsapp: 0, push: 0, email: 1 });
  });

  it("a complained-about address is no address: the email is refused, and the news goes to Telegram instead, once", async () => {
    // `sendEmail` asks the app's own database for marks (src/lib/domain/emailMarks.ts), so the mark goes there.
    await recordMark(await getDb(), "bea-news@example.com", "complaint", "test");
    const bea = await makePlayer(db, "Bea", { email: "bea-news@example.com", telegramId: 7_100_004 });
    const { org, ev } = await match();
    await decide(ev, org, bea, false);
    expect(heard(bea)).toEqual({ telegram: 1, whatsapp: 0, push: 0, email: 0 });
  });

  it("a yes on a full match: a complained-about address with push hears on push; a working address with Telegram hears by email, once", async () => {
    await recordMark(await getDb(), "wim-news@example.com", "complaint", "test");
    const wimRow = await makePlayer(db, "Wim", { email: "wim-news@example.com" });
    const wimAt = `/push-Wim-${n}`;
    await db.insert(pushSubscriptions).values({ playerId: wimRow.id, ...fakeSubscription(`https://127.0.0.1:${port}${wimAt}`) });
    const { org, ev } = await match([await makePlayer(db, "D1"), await makePlayer(db, "D2"), await makePlayer(db, "D3")]);
    expect(await decide(ev, org, wimRow, true)).toBe("waitlisted");
    expect(heard(wimRow, wimAt)).toEqual({ telegram: 0, whatsapp: 0, push: 1, email: 0 });
    const dee = await makePlayer(db, "Dee", { email: "dee-news@example.com", telegramId: 7_100_007 });
    const { org: org2, ev: ev2 } = await match([await makePlayer(db, "E1"), await makePlayer(db, "E2"), await makePlayer(db, "E3")]);
    expect(await decide(ev2, org2, dee, true)).toBe("waitlisted");
    expect(heard(dee)).toEqual({ telegram: 0, whatsapp: 0, push: 0, email: 1 });
    // The waiting list brings no calendar invitation: only a seat does.
    expect(mails("dee-news@example.com")[0].ics).toBeNull();
    expect(mails("dee-news@example.com")[0].subject).toContain("On the waiting list");
  });

  describe("a level confirmation that answers the request", () => {
    /** A match that admits only a confirmed level, `others` seated beside its organiser, and `p` asking to join it. */
    const verifiedMatch = async (p: Player, others: Player[] = []) => {
      const org = await makePlayer(db, `Org lv ${++n}`, { email: `org-lv-${n}@example.com` });
      const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist", levelMin: 3, levelMax: 4.5, levelVerifiedOnly: true });
      for (const x of [org, ...others]) await joinEvent(db, { eventId: ev.id, playerId: x.id, now: NOW });
      await createJoinRequest(db, { eventId: ev.id, playerId: p.id, level: 3.5, now: NOW });
      return { org, ev };
    };
    /** The organiser's own level tick, as `verifyLevelsAction` runs it: no level notice, then the admission's news. */
    const organiserTick = async (org: Player, p: Player) => {
      const player = await confirmLevel(db, { playerId: p.id, level: 3.5, byPlayerId: org.id, source: "organizer", now: NOW });
      const admitted = await admitConfirmed(db, player, org.id, NOW);
      await announceAdmission(db, player, admitted, "organizer", org.id);
      return admitted;
    };

    it("an organiser's level tick admits a Telegram-only requester, who hears it once, on Telegram", async () => {
      const tia = await makePlayer(db, "Tia", { level: 3.5, telegramId: 7_100_010 });
      const { org } = await verifiedMatch(tia);
      expect((await organiserTick(org, tia)).map((a) => a.join.outcome)).toEqual(["joined"]);
      expect(heard(tia)).toEqual({ telegram: 1, whatsapp: 0, push: 0, email: 0 });
      expect(telegram.find((m) => m.chat === "7100010")?.text).toContain("You're in");
    });

    it("a confirmation that puts a push-only requester on the waiting list of a full match tells them, once", async () => {
      const { p: pax, endpoint } = await pushOnly("Pax");
      await db.update(players).set({ level: 3.5 }).where(eq(players.id, pax.id));
      const full = [await makePlayer(db, "F1"), await makePlayer(db, "F2"), await makePlayer(db, "F3")];
      const { org } = await verifiedMatch(pax, full);
      expect((await organiserTick(org, pax)).map((a) => a.join.outcome)).toEqual(["waitlisted"]);
      expect(heard(pax, endpoint)).toEqual({ telegram: 0, whatsapp: 0, push: 1, email: 0 });
      expect((await db.select().from(notices).where(eq(notices.playerId, pax.id))).map((r) => r.key)).toEqual(["noticeItem.requestWaitlisted"]);
    });

    it("a coach's confirmation: the level notice that reached a Telegram player names the seat, so the seat is not told twice; a push-only player, whom it cannot reach, hears the seat on push", async () => {
      // The level notice reads nothing of the check itself: the player, the verifier's name, the answer and the seats.
      const check = {} as LevelCheck;
      const tod = await makePlayer(db, "Tod", { level: 3.5, telegramId: 7_100_011 });
      const { org } = await verifiedMatch(tod);
      const todNow = await confirmLevel(db, { playerId: tod.id, level: 3.5, byPlayerId: org.id, source: "coach", now: NOW });
      const todIn = await admitConfirmed(db, todNow, org.id, NOW);
      const toldTod = await notifyLevelCheckDecided(db, { check, player: todNow, verifierName: "Ana", approve: true, admitted: todIn });
      expect(toldTod).toBe(true);
      await announceAdmission(db, todNow, todIn, "coach", org.id, { told: toldTod });
      expect(heard(tod)).toEqual({ telegram: 1, whatsapp: 0, push: 0, email: 0 });

      const { p: poe, endpoint } = await pushOnly("Poe");
      await db.update(players).set({ level: 3.5 }).where(eq(players.id, poe.id));
      const { org: org2 } = await verifiedMatch(poe);
      const poeNow = await confirmLevel(db, { playerId: poe.id, level: 3.5, byPlayerId: org2.id, source: "coach", now: NOW });
      const poeIn = await admitConfirmed(db, poeNow, org2.id, NOW);
      const toldPoe = await notifyLevelCheckDecided(db, { check, player: poeNow, verifierName: "Ana", approve: true, admitted: poeIn });
      expect(toldPoe).toBe(false);
      await announceAdmission(db, poeNow, poeIn, "coach", org2.id, { told: toldPoe });
      expect(heard(poe, endpoint)).toEqual({ telegram: 0, whatsapp: 0, push: 1, email: 0 });
    });
  });

  it("quiet hours hold the news, as they hold every notice: nothing goes now, the inbox keeps it", async () => {
    const qui = await makePlayer(db, "Qui", { telegramId: 7_100_005, quietFrom: 0, quietTo: 24 * 60 - 1, quietTz: "Asia/Bangkok" });
    const { org, ev } = await match();
    await decide(ev, org, qui, true);
    expect(heard(qui)).toEqual({ telegram: 0, whatsapp: 0, push: 0, email: 0 });
    expect((await db.select().from(notices).where(eq(notices.playerId, qui.id))).map((r) => r.key)).toEqual(["noticeItem.requestApproved"]);
  });

  it("a kind switched off is never sent", async () => {
    const off = await makePlayer(db, "Off", { telegramId: 7_100_006, noticeKinds: { changes: false } });
    const { org, ev } = await match();
    await decide(ev, org, off, false);
    expect(heard(off)).toEqual({ telegram: 0, whatsapp: 0, push: 0, email: 0 });
    // The player row is untouched by the notice.
    expect((await db.select().from(players).where(eq(players.id, off.id)))[0].telegramId).toBe(7_100_006);
  });
});
