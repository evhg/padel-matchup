import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import { events, type Player } from "@/db/schema";
import { createEventAction, updateEventAction } from "@/actions/events";
import { bookingLinkOf } from "@/lib/domain/bookingLink";
import { bookingLinkFor, createEvent } from "@/lib/domain/events";
import { editErrorKey, noBookingLink } from "@/lib/editMatchForm";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { DAY, makePlayer } from "./helpers/db";

/**
 * The "Court booking link" field (the owner's report of 9 November 2026: "when I edit a match I can't
 * add booking link so each player knows where to pay their share?"). The edit form stored a pasted share
 * message as no link, and said nothing. Now a text keeps its link (`bookingLinkOf`): its first
 * made-to-share link, else its first link; a text with no link refuses the save, on create and on edit.
 */
const NOW = new Date(Date.UTC(2026, 10, 9, 4, 0));
freezeClock(NOW);

const PS = "https://thepadelsociety.app.link/AbC123";
const PT = "https://app.playtomic.io/matches/0f8a2b3c-1111-2222-3333-444455556666";
const MATCHI = "https://share.matchi.com/bookings/abc123-def";

describe("bookingLinkOf: what the booking link field keeps", () => {
  it.each([
    ["The Padel Society's share message", `Join my game on The Padel Society! ${PS}`, PS],
    ["Playtomic's share message, its tracking tag removed", `Join my match at Rawai Padel on Mon 10 Nov at 18:00!\n${PT}?utm_source=share`, PT],
    ["MATCHi's share message, its full stop removed", `You've been invited to join a game at Blue Tree: ${MATCHI}.`, MATCHI],
    ["a link before the words", `${PS} see you there`, PS],
    ["a made-to-share link wins over the link before it", `Club: https://rawaipadel.com/book Join: ${PS}`, PS],
    ["two other links: the first", "Book https://rawaipadel.com/book or https://kata.example/courts", "https://rawaipadel.com/book"],
    ["a bare link, as before", "https://example.com/my-booking?ref=7", "https://example.com/my-booking?ref=7"],
    ["a bare host gets https, as before", "krosspadel.com/book", "https://krosspadel.com/book"],
  ])("%s", (_, text, url) => {
    expect(bookingLinkOf(text)).toEqual({ ok: true, url });
  });

  it("an empty field is no link", () => {
    for (const v of ["", "   ", null, undefined]) expect(bookingLinkOf(v)).toEqual({ ok: true, url: null });
  });

  it.each([
    ["a share message with no link", "Join my game on The Padel Society!"],
    ["a payment line", "PromptPay 081 234 5678"],
    ["one word that is no host", "tomorrow"],
    ["a host inside words, with no https", "Book at krosspadel.com"],
    ["a link that is not http(s)", "ftp://example.com/booking"],
    ["a script", "javascript:alert(1)"],
  ])("refused: %s", (_, text) => {
    expect(bookingLinkOf(text)).toEqual({ ok: false });
  });

  it("the create door refuses a text with no link, and keeps the invitation when the field is empty", () => {
    expect(() => bookingLinkFor({ bookingUrl: "Join my game!", invite: PS })).toThrow("bookingUrl");
    expect(bookingLinkFor({ bookingUrl: `Join my game! ${PT}`, invite: PS })).toBe(PT);
    expect(bookingLinkFor({ bookingUrl: "", invite: PS })).toBe(PS);
  });

  it("the forms tell this refusal from any other, and say it under the field", () => {
    expect(noBookingLink({ error: "invalid", detail: "bookingUrl" })).toBe(true);
    expect(noBookingLink({ error: "invalid" })).toBe(false);
    expect(noBookingLink({ error: "forbidden", detail: "bookingUrl" })).toBe(false);
    expect(editErrorKey({ error: "invalid", detail: "bookingUrl" })).toBe("errors.invalid");
  });
});

describe("the edit form's save keeps a pasted link and refuses a text with none", () => {
  let db: Db;
  let n = 0;
  const as = (p: Player): Record<string, string> => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });
  /** A "Play again" match: no booking link, the organiser not seated. */
  const match = async () => {
    const org = await makePlayer(db, `Erik${++n}`);
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist", note: "Bring balls" });
    return { org, ev };
  };
  const row = async (id: string) => (await db.select().from(events).where(eq(events.id, id)))[0];

  beforeAll(async () => {
    db = await getDb();
  });

  it("a pasted share message stores its link", async () => {
    const { org, ev } = await match();
    const { result } = await asAction(as(org), () => updateEventAction(ev.code, { bookingUrl: `Join my game on The Padel Society! ${PS}` }));
    expect(result).toEqual({ ok: true, data: null });
    expect((await row(ev.id)).bookingUrl).toBe(PS);
  });

  it("a text with no link is refused, under the field, and the save stores nothing", async () => {
    const { org, ev } = await match();
    const { result } = await asAction(as(org), () => updateEventAction(ev.code, { bookingUrl: "Join my game on The Padel Society!", note: "New note" }));
    expect(result).toEqual({ ok: false, error: "invalid", detail: "bookingUrl" });
    const after = await row(ev.id);
    expect(after.bookingUrl).toBeNull();
    expect(after.note).toBe("Bring balls");
  });

  it("the create form refuses a text with no link before it makes a match", async () => {
    const org = await makePlayer(db, `Erik${++n}`);
    const { result } = await asAction(as(org), () => createEventAction({ type: "match", date: "2026-11-12", time: "18:00", tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist", bookingUrl: "Join my game!" }));
    expect(result).toEqual({ ok: false, error: "invalid", detail: "bookingUrl" });
    expect(await db.select({ id: events.id }).from(events).where(eq(events.creatorPlayerId, org.id))).toHaveLength(0);
  });

  it("a browser that knows nobody is refused before a record is made for it", async () => {
    const { result, cookies } = await asAction({}, () => createEventAction({ name: "Erik", type: "match", date: "2026-11-12", time: "18:00", tz: "Asia/Bangkok", whenFull: "waitlist", bookingUrl: "Join my game!" }));
    expect(result).toEqual({ ok: false, error: "invalid", detail: "bookingUrl" });
    expect(cookies[PLAYER_COOKIE]).toBeUndefined();
  });
});
