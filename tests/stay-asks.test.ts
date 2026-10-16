import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import { metricsDaily, type Player } from "@/db/schema";
import { updateMyEmail } from "@/actions/identity";
import { joinAction } from "@/actions/slots";
import { createEvent } from "@/lib/domain/events";
import { dayKey } from "@/lib/domain/metrics";
import { joinEvent } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { DAY, makePlayer } from "./helpers/db";

/**
 * "Stay updated" is the one ask that makes a new player reachable, and until 15 October 2026 nothing
 * counted it, and on the waiting list it said "Calendar invite sent" while the email held only the
 * personal link (reach). Now a web join that meets the ask counts `stay_asked`, a save on the card by a
 * player it asked counts `stay_linked_email`, each one upsert per join or save and never per view
 * (rule 12), and the save answers what went (`welcome`), so the card says only that. The card's save
 * says so (`{ from: "stay" }`); a save anywhere else (the invitation page, the email row) counts nothing.
 *
 * This deployment runs email alone (no bot, no WhatsApp number), so the card asks for email.
 */
const NOW = new Date(Date.UTC(2026, 9, 15, 4, 0));
/** The card's own save (`StayUpdated`). */
const STAY = { from: "stay" } as const;
freezeClock(NOW);

describe("the Stay updated card counts its asks and says only what went", () => {
  let db: Db;
  let sinkFile: string;
  type Mail = { to: string; subject: string; ics: { method: string } | null };
  const mails = (to: string): Mail[] => (existsSync(sinkFile) ? readFileSync(sinkFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Mail) : []).filter((m) => m.to === to);
  const metric = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, key))))[0]?.value ?? 0);
  const as = (p: Player, o: { byName?: boolean } = {}): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id, o) });
  let n = 0;
  /** A match of four, its organiser not seated, so each test seats whom it needs. */
  const match = async () => {
    const org = await makePlayer(db, `Org${++n}`);
    return createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
  };

  beforeAll(async () => {
    db = await getDb();
  });
  beforeEach(() => {
    process.env.RESEND_API_KEY = "re_test_only";
    sinkFile = path.join(mkdtempSync(path.join(tmpdir(), "stay-asks-")), "mail.jsonl");
    process.env.EMAIL_SINK_FILE = sinkFile;
  });

  it("a web join that meets the ask counts stay_asked once, a seat or a waiting place; a player with a channel counts nothing", async () => {
    const ev = await match();
    const asked = await metric("stay_asked");
    const nia = await makePlayer(db, "Nia");
    expect((await asAction(as(nia), () => joinAction(ev.code))).result).toMatchObject({ ok: true, data: { outcome: "joined" } });
    expect(await metric("stay_asked")).toBe(asked + 1);
    for (const name of ["Ann", "Bo"]) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, name)).id });
    // Reached already: the card is one quiet line, and asks nothing.
    const tom = await makePlayer(db, "Tom", { email: "tom-stay@example.com" });
    expect((await asAction(as(tom), () => joinAction(ev.code))).result).toMatchObject({ ok: true, data: { outcome: "joined" } });
    expect(await metric("stay_asked")).toBe(asked + 1);
    // The match is full: the waiting list sees the card too.
    const wes = await makePlayer(db, "Wes");
    expect((await asAction(as(wes), () => joinAction(ev.code))).result).toMatchObject({ ok: true, data: { outcome: "waitlisted" } });
    expect(await metric("stay_asked")).toBe(asked + 2);
  });

  it("a seat that saves an address on the card gets the invitation, the answer says \"invite\", and stay_linked_email counts once", async () => {
    const ev = await match();
    const nia = await makePlayer(db, "Nia");
    await joinEvent(db, { eventId: ev.id, playerId: nia.id });
    const linked = await metric("stay_linked_email");
    expect((await asAction(as(nia), () => updateMyEmail("nia-stay@example.com", ev.code, STAY))).result).toMatchObject({ ok: true, data: { email: "nia-stay@example.com", welcome: "invite" } });
    expect(mails("nia-stay@example.com").map((m) => m.ics?.method)).toEqual(["REQUEST"]);
    expect(await metric("stay_linked_email")).toBe(linked + 1);
    // The same address again changes nothing: nothing goes, and nothing counts.
    expect((await asAction(as(nia), () => updateMyEmail("nia-stay@example.com", ev.code, STAY))).result).toMatchObject({ ok: true, data: { welcome: null } });
    expect(mails("nia-stay@example.com")).toHaveLength(1);
    // A new address from a player the card no longer asked: the invitation goes there, and it is no new link.
    expect((await asAction(as(nia), () => updateMyEmail("nia-new@example.com", ev.code, STAY))).result).toMatchObject({ ok: true, data: { welcome: "invite" } });
    expect(await metric("stay_linked_email")).toBe(linked + 1);
  });

  it("a waiting place that saves an address gets the personal link, not an invitation, and the answer says \"link\"", async () => {
    const ev = await match();
    for (const name of ["Ann", "Bo", "Cy", "Di"]) await joinEvent(db, { eventId: ev.id, playerId: (await makePlayer(db, name)).id });
    const wes = await makePlayer(db, "Wes");
    expect((await joinEvent(db, { eventId: ev.id, playerId: wes.id })).outcome).toBe("waitlisted");
    const linked = await metric("stay_linked_email");
    expect((await asAction(as(wes), () => updateMyEmail("wes-stay@example.com", ev.code, STAY))).result).toMatchObject({ ok: true, data: { welcome: "link" } });
    const got = mails("wes-stay@example.com");
    expect(got).toHaveLength(1);
    expect(got[0].ics).toBeNull();
    expect(got[0].subject).toBe("Your Kicksmash link");
    expect(await metric("stay_linked_email")).toBe(linked + 1);
  });

  it("a session by name gets no welcome and the answer says null; its address still reaches it, so the link counts", async () => {
    const ev = await match();
    const bea = await makePlayer(db, "Bea");
    await joinEvent(db, { eventId: ev.id, playerId: bea.id });
    const linked = await metric("stay_linked_email");
    expect((await asAction(as(bea, { byName: true }), () => updateMyEmail("bea-stay@example.com", ev.code, STAY))).result).toMatchObject({ ok: true, data: { welcome: null } });
    expect(mails("bea-stay@example.com")).toEqual([]);
    expect(await metric("stay_linked_email")).toBe(linked + 1);
  });

  // The invitation page's form (`CalendarEmail`) and the match page's email row save with the match's code
  // too, and neither is the card: the invitation page never shows it, and `stay_asked` never counted the
  // invitee who confirmed there (review, 15 October 2026). Nia here is just like the seat above, but for the door.
  it("a save with the match's code off the card (the invitation page, the email row) gets its welcome, and counts nothing", async () => {
    const ev = await match();
    const nia = await makePlayer(db, "Nia");
    await joinEvent(db, { eventId: ev.id, playerId: nia.id });
    const linked = await metric("stay_linked_email");
    expect((await asAction(as(nia), () => updateMyEmail("nia-invite-page@example.com", ev.code))).result).toMatchObject({ ok: true, data: { welcome: "invite" } });
    expect(mails("nia-invite-page@example.com").map((m) => m.ics?.method)).toEqual(["REQUEST"]);
    expect(await metric("stay_linked_email")).toBe(linked);
  });

  it("an address saved away from a match page (My matches) is no answer to the card: the welcome goes, and nothing counts", async () => {
    const lu = await makePlayer(db, "Lu");
    const linked = await metric("stay_linked_email");
    // With the card's mark even, so the match's code is the one thing that keeps it out.
    expect((await asAction(as(lu), () => updateMyEmail("lu-stay@example.com", undefined, STAY))).result).toMatchObject({ ok: true, data: { welcome: "link" } });
    expect(mails("lu-stay@example.com")).toHaveLength(1);
    expect(await metric("stay_linked_email")).toBe(linked);
  });
});
