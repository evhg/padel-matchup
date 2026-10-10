import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import type { Player } from "@/db/schema";
import { matchToPublic } from "@/lib/api/serialize";
import { courtBookedBy, mayMarkBooked, setCourtBooked } from "@/lib/domain/courtBooked";
import { cancelEvent, createEvent, updateEvent } from "@/lib/domain/events";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { renderCard } from "@/lib/telegram/card";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * "I booked it": a player in the match booked and paid in the club's own app, and one tap tells the
 * others. Who and when, nothing else; any player of the match may take it back; a new day, hour,
 * length or club clears it. The page, the card and the API all say "Court booked ✓ (by Ana)".
 *
 * NOW is Saturday 10 October 2026, 05:00 UTC. The match is two days later.
 */
const NOW = new Date("2026-10-10T05:00:00Z");
freezeClock(NOW);

describe("court booked", () => {
  let db: Db;
  let close: () => Promise<void>;
  let olga: Player;
  let ana: Player;
  let ben: Player;
  const fresh = async (code: string) => (await getEventByCode(db, code)) as EventDetail;

  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    olga = await makePlayer(db, "Olga");
    ana = await makePlayer(db, "Ana Maria");
    ben = await makePlayer(db, "Ben");
  });
  afterAll(async () => close());

  async function match() {
    const ev = await createEvent(db, { creatorPlayerId: olga.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", court: "2", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: olga.id });
    await joinEvent(db, { eventId: ev.id, playerId: ana.id });
    return fresh(ev.code);
  }

  it("only the organiser and the players in a seat may mark it, and a stranger is refused", async () => {
    const d = await match();
    expect(mayMarkBooked(d, olga.id)).toBe(true);
    expect(mayMarkBooked(d, ana.id)).toBe(true);
    expect(mayMarkBooked(d, ben.id)).toBe(false);
    expect(mayMarkBooked(d, null)).toBe(false);
    await expect(setCourtBooked(db, d, ben.id, true, NOW)).rejects.toMatchObject({ code: "forbidden" });
    expect(courtBookedBy(await fresh(d.event.code))).toBeNull();
  });

  it("a player marks it; the first booker stays; the page, the card and the API say who; any player takes it back", async () => {
    const d = await match();
    expect(await setCourtBooked(db, d, ana.id, true, NOW)).toBe(true);
    // A second "I booked it" changes nothing: Ana booked it.
    expect(await setCourtBooked(db, await fresh(d.event.code), olga.id, true, new Date(NOW.getTime() + 60_000))).toBe(false);
    const booked = await fresh(d.event.code);
    expect(courtBookedBy(booked)).toEqual({ at: NOW, name: "Ana" });
    expect(matchToPublic(booked, "https://kicksma.sh").courtBooked).toEqual({ at: NOW.toISOString(), by: "Ana" });
    expect(renderCard(booked, "https://kicksma.sh", "en", NOW).text).toContain("🎟 Court booked ✓ (by Ana)");
    expect(renderCard(booked, "https://kicksma.sh", "ru", NOW).text).toContain("🎟 Корт забронирован ✓ (Ana)");
    expect(renderCard(booked, "https://kicksma.sh", "es", NOW).text).toContain("🎟 Pista reservada ✓ (por Ana)");

    // Olga takes it back: one tap, and every surface forgets it.
    expect(await setCourtBooked(db, booked, olga.id, false)).toBe(true);
    const undone = await fresh(d.event.code);
    expect(courtBookedBy(undone)).toBeNull();
    expect(matchToPublic(undone, "https://kicksma.sh").courtBooked).toBeNull();
    expect(renderCard(undone, "https://kicksma.sh", "en", NOW).text).not.toContain("Court booked");
    expect(await setCourtBooked(db, undone, olga.id, false)).toBe(false);
  });

  it("a new day, hour, length or club clears it; a note or a court number does not", async () => {
    const d = await match();
    await setCourtBooked(db, d, ana.id, true, NOW);
    await updateEvent(db, d.event.id, olga.id, { note: "Bring balls", court: "3" });
    expect(courtBookedBy(await fresh(d.event.code))?.name).toBe("Ana");
    await updateEvent(db, d.event.id, olga.id, { startsAt: new Date(d.event.startsAt.getTime() + 3600_000) });
    expect(courtBookedBy(await fresh(d.event.code))).toBeNull();
    await setCourtBooked(db, await fresh(d.event.code), ana.id, true, NOW);
    await updateEvent(db, d.event.id, olga.id, { durationMinutes: 120 });
    expect(courtBookedBy(await fresh(d.event.code))).toBeNull();
    await setCourtBooked(db, await fresh(d.event.code), ana.id, true, NOW);
    await updateEvent(db, d.event.id, olga.id, { venueName: "Chalong Padel" });
    expect(courtBookedBy(await fresh(d.event.code))).toBeNull();
  });

  it("a cancelled match takes no mark", async () => {
    const d = await match();
    await cancelEvent(db, d.event.id, olga.id);
    await expect(setCourtBooked(db, await fresh(d.event.code), ana.id, true, NOW)).rejects.toMatchObject({ code: "cancelled" });
  });
});
