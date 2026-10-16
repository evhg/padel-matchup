import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { proveMyEmail, updateMyEmail } from "@/actions/identity";
import { setCreatorEmailAction } from "@/actions/events";
import { confirmInviteAction } from "@/actions/slots";
import { createEvent } from "@/lib/domain/events";
import { joinEvent, reserveSlot } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { DAY, makePlayer } from "./helpers/db";

/**
 * The owner's decision of 16 October 2026 (D3, DECIDING rule 34). The question: "A browser that signed in
 * by name ("That's me") can type an email on the card. The next match email then carries the record's
 * personal link, which is a permanent sign-in. Must that address prove itself first?" The answer: "Code
 * first (Recommended)": "Ask for the existing 6-digit email code before the address is saved."
 *
 * Every door that saves an address for the session's own record asks it: `updateMyEmail` (the card, the
 * invitation page's form, the email row, My matches), `setCreatorEmailAction` (the organiser's own
 * address) and `confirmInviteAction` (the invitation's "I'm in" with an address). A by-name save keeps
 * nothing and sends the code; the right code saves the address as proved and the session becomes a full
 * one; a wrong code saves nothing; a full session saves as before, with no code.
 */
const NOW = new Date(Date.UTC(2026, 9, 16, 4, 0));
freezeClock(NOW);

describe("an address typed by a session by name proves itself with the 6-digit code first", () => {
  let db: Db;
  let sinkFile: string;
  type Mail = { to: string; subject: string; ics: { method: string } | null };
  const mails = (to: string): Mail[] => (existsSync(sinkFile) ? readFileSync(sinkFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Mail) : []).filter((m) => m.to === to);
  const codeIn = (to: string) => mails(to).map((m) => m.subject.match(/^(\d{6}) is your Kicksmash code$/)?.[1]).find(Boolean) ?? "";
  const byName = (p: Player) => ({ [PLAYER_COOKIE]: sealPlayerId(p.id, { byName: true }) });
  const full = (p: Player) => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
  const emailOf = async (p: Player) => (await db.select().from(players).where(eq(players.id, p.id)))[0];
  let n = 0;
  const match = async (creator?: Player) => {
    const org = creator ?? (await makePlayer(db, `Org${++n}`));
    return { org, ev: await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" }) };
  };

  beforeAll(async () => {
    db = await getDb();
  });
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_only";
    sinkFile = path.join(mkdtempSync(path.join(tmpdir(), "email-proof-")), "mail.jsonl");
    process.env.EMAIL_SINK_FILE = sinkFile;
  });

  it("a by-name save sends a code and saves nothing: no address on the record, no invitation, the session still by name", async () => {
    const { ev } = await match();
    const ana = await makePlayer(db, "Ana");
    await joinEvent(db, { eventId: ev.id, playerId: ana.id });
    const { result, cookies } = await asAction(byName(ana), () => updateMyEmail("ana-proof@example.com", ev.code));
    expect(result).toMatchObject({ ok: true, data: { email: null, welcome: null, code: "sent" } });
    const row = await emailOf(ana);
    expect([row.email, row.emailVerifiedAt]).toEqual([null, null]);
    // One mail, the code, with no calendar file and no link in it.
    const got = mails("ana-proof@example.com");
    expect(got).toHaveLength(1);
    expect(got[0].ics).toBeNull();
    expect(codeIn("ana-proof@example.com")).toMatch(/^\d{6}$/);
    expect(cookies[PLAYER_COOKIE], "the session is still the one by name").toBe(sealPlayerId(ana.id, { byName: true }));
  });

  it("the right code saves the address as proved, ends the by-name mark, and sends what a full session's save sends", async () => {
    const { ev } = await match();
    const bo = await makePlayer(db, "Bo");
    await joinEvent(db, { eventId: ev.id, playerId: bo.id });
    await asAction(byName(bo), () => updateMyEmail("bo-proof@example.com", ev.code));
    const { result, cookies } = await asAction(byName(bo), () => proveMyEmail("bo-proof@example.com", codeIn("bo-proof@example.com"), ev.code));
    expect(result).toMatchObject({ ok: true, data: { email: "bo-proof@example.com", welcome: "invite" } });
    const row = await emailOf(bo);
    expect(row.email).toBe("bo-proof@example.com");
    expect(row.emailVerifiedAt).not.toBeNull();
    // The same record, now a full session: the cookie carries no by-name mark.
    expect(cookies[PLAYER_COOKIE]).toBe(sealPlayerId(bo.id));
    expect(mails("bo-proof@example.com").map((m) => m.ics?.method ?? null)).toEqual([null, "REQUEST"]);
  });

  it("a wrong code saves nothing, and the session stays by name", async () => {
    const { ev } = await match();
    const cy = await makePlayer(db, "Cy");
    await joinEvent(db, { eventId: ev.id, playerId: cy.id });
    await asAction(byName(cy), () => updateMyEmail("cy-proof@example.com", ev.code));
    const right = codeIn("cy-proof@example.com");
    const wrong = right === "000000" ? "111111" : "000000";
    const { result, cookies } = await asAction(byName(cy), () => proveMyEmail("cy-proof@example.com", wrong, ev.code));
    expect(result).toMatchObject({ ok: false, error: "invalid" });
    expect(cookies[PLAYER_COOKIE]).toBe(sealPlayerId(cy.id, { byName: true }));
    expect((await emailOf(cy)).email).toBeNull();
    expect(mails("cy-proof@example.com")).toHaveLength(1);
  });

  it("a full session saves as before, with no code", async () => {
    const { ev } = await match();
    const di = await makePlayer(db, "Di");
    await joinEvent(db, { eventId: ev.id, playerId: di.id });
    const { result } = await asAction(full(di), () => updateMyEmail("di-proof@example.com", ev.code));
    expect(result).toMatchObject({ ok: true, data: { email: "di-proof@example.com", welcome: "invite", code: null } });
    expect((await emailOf(di)).email).toBe("di-proof@example.com");
    expect(mails("di-proof@example.com").map((m) => m.ics?.method)).toEqual(["REQUEST"]);
  });

  it("the organiser's own address from a session by name waits for the code too; a full organiser saves it at once", async () => {
    const eve = await makePlayer(db, "Eve");
    const { ev } = await match(eve);
    expect((await asAction(byName(eve), () => setCreatorEmailAction(ev.code, "eve-proof@example.com"))).result).toEqual({ ok: true, data: { code: "sent" } });
    expect((await emailOf(eve)).email).toBeNull();
    expect(mails("eve-proof@example.com").map((m) => m.ics)).toEqual([null]);
    const fay = await makePlayer(db, "Fay");
    const { ev: ev2 } = await match(fay);
    expect((await asAction(full(fay), () => setCreatorEmailAction(ev2.code, "fay-proof@example.com"))).result).toEqual({ ok: true, data: { code: null } });
    expect((await emailOf(fay)).email).toBe("fay-proof@example.com");
  });

  it("\"I'm in\" on an invitation keeps no address from a session by name, and keeps one from a full session", async () => {
    const { org, ev } = await match();
    const gus = await makePlayer(db, "Gus");
    const { slot } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Gus" });
    expect((await asAction(byName(gus), () => confirmInviteAction(ev.code, slot.inviteCode!, { email: "gus-proof@example.com" }))).result).toMatchObject({ ok: true, data: { outcome: "confirmed" } });
    expect((await emailOf(gus)).email).toBeNull();
    const hal = await makePlayer(db, "Hal");
    const { slot: slot2 } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Hal" });
    expect((await asAction(full(hal), () => confirmInviteAction(ev.code, slot2.inviteCode!, { email: "hal-proof@example.com" }))).result).toMatchObject({ ok: true, data: { outcome: "confirmed" } });
    expect((await emailOf(hal)).email).toBe("hal-proof@example.com");
  });
});
