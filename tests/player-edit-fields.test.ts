import { createElement } from "react";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import { events, type Event, type Player } from "@/db/schema";
import { updateEventAction } from "@/actions/events";
import { EventFields, type EventFormValues } from "@/components/EventFields";
import { createEvent, organiserOnlyFields, PLAYER_EDIT_FIELDS, updateEvent } from "@/lib/domain/events";
import { editErrorKey } from "@/lib/editMatchForm";
import { joinEvent } from "@/lib/domain/slots";
import { grantManageAccess, PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { catalogue, renderIn } from "./helpers/render";
import { DAY, makePlayer } from "./helpers/db";

/**
 * The owner's decision of 9 November 2026 (DECIDING rule 34). The question's option: "Players edit only
 * time/place/note": "Today any seated player can also change the level range, 'when full', the board
 * listing, booking link and cost, and nobody hears about those changes. Limit players to time, place and
 * note."
 *
 * A seated player who is not the organiser changes the day, the time, the zone, the length, the place, the
 * court, the map and the note (`PLAYER_EDIT_FIELDS`). `updateEvent` refuses anything else from such a
 * player, whatever the browser sends; the organiser, by the session or by the manage link, keeps every field.
 */
const NOW = new Date(Date.UTC(2026, 10, 9, 4, 0));
freezeClock(NOW);
const TZ = "Asia/Bangkok";

/** Each organiser's field with a value a browser could send through the action (`updateSchema`). */
const ORGANISER_FIELDS = {
  title: "Friday smash",
  whenFull: "closed",
  capacity: 8,
  levelMin: 3,
  levelMax: 4,
  levelVerifiedOnly: true,
  category: "women",
  ageMin: 35,
  publicListing: true,
  bookingUrl: "https://playtomic.io/booking/abc",
  cost: "300 THB",
  payNote: "PromptPay to Org",
} as const;

let db: Db;
let n = 0;
beforeAll(async () => {
  db = await getDb();
});

/** A match three days out, its organiser, and one seated player; names made for this test alone. */
async function matchWithPlayer(): Promise<{ org: Player; bo: Player; ev: Event }> {
  const org = await makePlayer(db, `Org edit ${++n}`);
  const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: TZ, venueName: "Rawai Padel", whenFull: "waitlist" });
  const bo = await makePlayer(db, `Bo edit ${n}`);
  await joinEvent(db, { eventId: ev.id, playerId: bo.id, now: NOW });
  return { org, bo, ev };
}
const rowOf = async (id: string) => (await db.select().from(events).where(eq(events.id, id)))[0];
const as = (p: Player) => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });

describe("which fields a seated player may send", () => {
  it("names every field that is not a player's, and none of a player's", () => {
    expect([...PLAYER_EDIT_FIELDS].sort()).toEqual(["court", "durationMinutes", "note", "startsAt", "tz", "venueMapUrl", "venueName"]);
    for (const k of Object.keys(ORGANISER_FIELDS)) expect(organiserOnlyFields({ [k]: (ORGANISER_FIELDS as Record<string, unknown>)[k] }), k).toEqual([k]);
    expect(organiserOnlyFields({ note: "x", startsAt: NOW, durationMinutes: 90, tz: TZ, venueName: "Rawai", venueMapUrl: "https://maps.app.goo.gl/x", court: "3" })).toEqual([]);
    // A key the action fills with undefined (nothing was sent) is no field sent.
    expect(organiserOnlyFields({ note: "x", cost: undefined, levelMin: undefined })).toEqual([]);
    // Null is a value: it takes the range off.
    expect(organiserOnlyFields({ levelMin: null, levelMax: null })).toEqual(["levelMin", "levelMax"]);
  });

  it("the refusal says what a player can change, in every language", () => {
    expect(editErrorKey({ error: "forbidden", detail: "organiserOnly" })).toBe("event.organiserOnly");
    expect(editErrorKey({ error: "forbidden", detail: "startsAt" })).toBe("event.startLocked");
    expect(editErrorKey({ error: "forbidden" })).toBe("errors.invalid");
    const WORDS = { en: ["organiser", "note"], ru: ["организатор", "заметку"], es: ["organizador", "nota"] } as const;
    for (const l of ["en", "ru", "es"] as const) {
      const ev = catalogue(l).event as Record<string, string>;
      for (const w of WORDS[l]) expect(ev.organiserOnly, `${l}: ${w}`).toContain(w);
      // The help over the form says the same, and that a new note tells nobody.
      for (const w of WORDS[l].slice(1)) expect(ev.changeDetailsHelp, `${l}: ${w}`).toContain(w);
    }
  });
});

describe("the edit action, called as the browser calls it", () => {
  it("saves a seated player's day, time, length, place, court, map and note", async () => {
    const { bo, ev } = await matchWithPlayer();
    const { result } = await asAction(as(bo), () =>
      updateEventAction(ev.code, { date: "2026-11-13", time: "19:30", tz: TZ, durationMinutes: 120, venueName: "Phuket Padel Club", venueMapUrl: "https://maps.app.goo.gl/abc", court: "4", note: "Bring balls" }),
    );
    expect(result).toEqual({ ok: true, data: null });
    const row = await rowOf(ev.id);
    expect({ venue: row.venueName, court: row.court, note: row.note, minutes: row.durationMinutes, map: row.venueMapUrl }).toEqual({ venue: "Phuket Padel Club", court: "4", note: "Bring balls", minutes: 120, map: "https://maps.app.goo.gl/abc" });
    expect(row.startsAt.toISOString()).toBe("2026-11-13T12:30:00.000Z");
  });

  it.each(Object.entries(ORGANISER_FIELDS))("refuses a seated player's %s, and changes nothing", async (field, value) => {
    const { bo, ev } = await matchWithPlayer();
    const before = await rowOf(ev.id);
    // With a note beside it: the refusal is the whole save, never the half a player may make.
    const { result } = await asAction(as(bo), () => updateEventAction(ev.code, { note: "sneaked in", [field]: value }));
    expect(result).toEqual({ ok: false, error: "forbidden", detail: "organiserOnly" });
    expect(await rowOf(ev.id)).toEqual(before);
  });

  it("saves every field for the organiser by the session", async () => {
    const { org, ev } = await matchWithPlayer();
    const { result } = await asAction(as(org), () => updateEventAction(ev.code, { note: "Org's note", title: "Friday smash", whenFull: "closed", levelMin: 3, levelMax: 4, cost: "300 THB", bookingUrl: "https://playtomic.io/booking/abc" }));
    expect(result).toEqual({ ok: true, data: null });
    const row = await rowOf(ev.id);
    expect({ title: row.title, whenFull: row.whenFull, min: row.levelMin, max: row.levelMax, cost: row.cost, booking: row.bookingUrl, note: row.note }).toEqual({ title: "Friday smash", whenFull: "closed", min: 3, max: 4, cost: "300 THB", booking: "https://playtomic.io/booking/abc", note: "Org's note" });
  });

  it("saves every field for the organiser by the manage link, in a browser that knows no player", async () => {
    const { ev } = await matchWithPlayer();
    const granted = await asAction({}, async () => grantManageAccess(ev.code, ev.manageCode));
    const { result } = await asAction(granted.cookies, () => updateEventAction(ev.code, { cost: "250 THB", whenFull: "closed" }));
    expect(result).toEqual({ ok: true, data: null });
    const row = await rowOf(ev.id);
    expect({ cost: row.cost, whenFull: row.whenFull }).toEqual({ cost: "250 THB", whenFull: "closed" });
  });

  it("the domain takes the creator's own record as the organiser, with no manage link", async () => {
    // The Telegram board button passes `asOrganiser`; a caller that passes only the creator's id is the organiser too.
    const { org, ev } = await matchWithPlayer();
    const res = await updateEvent(db, ev.id, org.id, { cost: "200 THB" }, NOW);
    expect(res.event.cost).toBe("200 THB");
    // And the same call for anybody else is a player's.
    const other = await makePlayer(db, `Cy edit ${n}`);
    await expect(updateEvent(db, ev.id, other.id, { cost: "1 THB" }, NOW)).rejects.toMatchObject({ code: "forbidden", message: "organiserOnly" });
  });
});

describe("the player's form holds only a player's fields", () => {
  const values: EventFormValues = {
    type: "match", haveNames: "", title: "", date: "2026-11-12", time: "18:00", durationMinutes: 90, tz: TZ, venueName: "Rawai Padel", venueMapUrl: "", court: "", note: "", capacity: 4, whenFull: "waitlist",
    courts: null, pointsPerMatch: null, gamesTo: null, format: "americano", fixedPairs: false, levelMin: null, levelMax: null, levelVerifiedOnly: false, category: null, ageMin: null, myLevel: null, publicListing: false, bookingUrl: "", cost: "", payNote: "",
  };
  const form = (playerFields: boolean) => renderIn("en", createElement(EventFields, { values, onChange: () => undefined, venues: [], showType: false, playerFields }));

  it("shows the note at once, and no level range, no tags and no \"More options\"", () => {
    const html = form(true);
    expect(html).toContain("Bring balls, level 3.5, parking tips");
    for (const gone of ["level-chip", "More options"]) expect(html, gone).not.toContain(gone);
    // The organiser's form keeps them.
    const org = form(false);
    for (const kept of ["level-chip", "More options"]) expect(org, kept).toContain(kept);
  });
});
