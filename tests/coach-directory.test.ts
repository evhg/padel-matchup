import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { acceptByInvite, blockTime, bookLesson, busyForCoaches, coachCardFacts, createCoach, nextFree, NO_BUSY, offersForCoaches, openHour, packagePriceFrom, presetHours, priceFrom, requestStudent, saveOffers, setStudentStatus, studentStatus, updateCoach } from "@/lib/domain/coaching";
import { decideRequest, listOpenRequests, requestOrBook } from "@/lib/coach/chains";
import { createTestDb, makePlayer, DAY, HOUR } from "./helpers/db";

/**
 * The player's side of the directory: what a card says, and whether a stranger can take an hour.
 * Before this, three coaches read exactly alike (a name, a length, a club) and every one of them
 * ended on "Ask to become a student", so nobody could compare and nobody could book.
 */
describe("the coach directory", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  // A Monday 00:00 UTC. Every time below counts from it, never from today (rule 11).
  // The morning template is 07:00–12:00 Bangkok, which is 00:00–05:00 UTC, so at(0) is the first hour.
  const monday = new Date("2026-10-05T00:00:00.000Z");
  const at = (h: number) => new Date(monday.getTime() + h * HOUR);
  // Two hours before the Monday template opens: the Sunday morning window (00:00-05:00 UTC) has
  // already closed, and the coach's default two-hour notice makes at(0) the first bookable hour.
  const before = new Date(monday.getTime() - 2 * HOUR);

  const aCoach = async (name: string, patch: Parameters<typeof updateCoach>[2] = {}) => {
    const p = await makePlayer(db, name);
    const coach = await createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("mornings") });
    return Object.keys(patch).length ? updateCoach(db, coach.id, patch) : coach;
  };

  it("reads the diary of a whole list in one go, busy and opened hours apart", async () => {
    const one = await aCoach("Nina");
    const two = await aCoach("Omar");
    const three = await aCoach("Pia");
    await blockTime(db, { coachId: one.id, startsAt: at(1), minutes: 60 }, before);
    // 13:00 Bangkok: outside the morning template, so it is an opening and not busy time.
    await openHour(db, two.id, at(6), two.lessonMinutes);
    const map = await busyForCoaches(db, [one.id, two.id, three.id], before, new Date(monday.getTime() + 14 * DAY));

    expect(map.get(one.id)?.busy.map((b) => b.startsAt.toISOString())).toEqual([at(1).toISOString()]);
    expect(map.get(one.id)?.openings).toEqual([]);
    expect(map.get(two.id)?.busy).toEqual([]);
    expect(map.get(two.id)?.openings.map((o) => o.startsAt.toISOString())).toEqual([at(6).toISOString()]);
    // A coach with nothing in the diary is still in the map, so a card never has to guess.
    expect(map.get(three.id)).toEqual({ busy: [], openings: [] });
    expect(await busyForCoaches(db, [], before, at(1))).toEqual(new Map());
  });

  it("says the first free hour, and counts an hour the coach opened outside the week", async () => {
    const coach = await aCoach("Quinn");
    await blockTime(db, { coachId: coach.id, startsAt: at(0), minutes: 60 }, before);
    const map = await busyForCoaches(db, [coach.id], before, new Date(monday.getTime() + 14 * DAY));
    // The 07:00 hour is blocked, so the first free one is 08:00 Bangkok.
    expect(nextFree(coach, map.get(coach.id) ?? NO_BUSY, before)?.toISOString()).toBe(at(1).toISOString());

    // A coach whose whole week is empty has no free hour at all, until they open one date.
    const quiet = await aCoach("Rui", { hours: {} });
    expect(nextFree(quiet, NO_BUSY, before)).toBeNull();
    await openHour(db, quiet.id, at(6), quiet.lessonMinutes);
    const quietMap = await busyForCoaches(db, [quiet.id], before, new Date(monday.getTime() + 14 * DAY));
    expect(nextFree(quiet, quietMap.get(quiet.id) ?? NO_BUSY, before)?.toISOString()).toBe(at(6).toISOString());
  });

  it("quotes the price of a lesson for one, never the price of a lesson for four", () => {
    // priceFour is the price of a lesson shared by four, so it is the biggest number and the least
    // like what one person pays. A card that showed it would say "from 2400" to somebody alone.
    expect(priceFrom({ priceSingle: 1200, priceSecondSingle: 800 })).toBe(800);
    expect(priceFrom({ priceSingle: 1200, priceSecondSingle: null })).toBe(1200);
    expect(priceFrom({ priceSingle: null, priceSecondSingle: null })).toBeNull();
  });

  it("puts on the card what a player chooses between", async () => {
    const coach = await aCoach("Sofia", { priceSingle: 1200, currency: "thb", teachesLevelMin: 2, teachesLevelMax: 4.5, openBooking: true, bio: "Ten years on clay." });
    const facts = coachCardFacts(coach, NO_BUSY, [], before);
    expect(facts).toMatchObject({ handle: coach.handle, displayName: "Sofia", priceFrom: 1200, currency: "THB", openBooking: true, levels: { min: 2, max: 4.5 } });
    expect(facts.nextFree).toBe(at(0).toISOString());
  });

  it("keeps the taught levels on the scale and the right way round", async () => {
    const coach = await aCoach("Tom", { teachesLevelMin: 4, teachesLevelMax: 2 });
    expect([coach.teachesLevelMin, coach.teachesLevelMax]).toEqual([2, 4]);
    const clamped = await updateCoach(db, coach.id, { teachesLevelMin: -3, teachesLevelMax: 99 });
    expect([clamped.teachesLevelMin, clamped.teachesLevelMax]).toEqual([0, 7]);
    const halved = await updateCoach(db, coach.id, { teachesLevelMin: 2.4, teachesLevelMax: null });
    expect([halved.teachesLevelMin, halved.teachesLevelMax]).toEqual([2.5, null]);
  });
});

/**
 * "Anyone can book": the booking is the joining. The coach still decides who stays — a paused
 * student is paused for a reason, and off is still the default for everybody.
 */
describe("booking without asking first", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  const monday = new Date("2026-10-05T00:00:00.000Z");
  const at = (h: number) => new Date(monday.getTime() + h * HOUR);
  const before = new Date(monday.getTime() - DAY);

  const aCoach = async (name: string, openBooking: boolean) => {
    const p = await makePlayer(db, name);
    const coach = await createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("mornings") });
    return updateCoach(db, coach.id, { openBooking });
  };

  it("puts a stranger on the list the moment they take an hour", async () => {
    const coach = await aCoach("Ula", true);
    const anna = await makePlayer(db, "Anna");
    expect(await studentStatus(db, coach.id, anna.id)).toBe("none");
    const { lesson } = await bookLesson(db, { coach, studentPlayerId: anna.id, startsAt: at(1), byCoach: false, source: "web" }, before);
    expect(lesson.startsAt.toISOString()).toBe(at(1).toISOString());
    expect(await studentStatus(db, coach.id, anna.id)).toBe("accepted");
  });

  it("still refuses a stranger when the coach did not open the door", async () => {
    const coach = await aCoach("Vik", false);
    const bo = await makePlayer(db, "Bo");
    await expect(bookLesson(db, { coach, studentPlayerId: bo.id, startsAt: at(1), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "not_student" });
    expect(await studentStatus(db, coach.id, bo.id)).toBe("none");
  });

  it("refuses a paused student, because the coach paused them on purpose", async () => {
    const coach = await aCoach("Wen", true);
    const cai = await makePlayer(db, "Cai");
    await setStudentStatus(db, coach.id, cai.id, "paused");
    await expect(bookLesson(db, { coach, studentPlayerId: cai.id, startsAt: at(1), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "not_student" });
    expect(await studentStatus(db, coach.id, cai.id)).toBe("paused");
  });

  it("leaves no student behind when the booking itself is refused", async () => {
    const coach = await aCoach("Xan", true);
    const dee = await makePlayer(db, "Dee");
    const eve = await makePlayer(db, "Eve");
    await bookLesson(db, { coach, studentPlayerId: dee.id, startsAt: at(2), byCoach: false, source: "web" }, before);
    // The hour is gone, and an hour outside the week was never on offer.
    await expect(bookLesson(db, { coach, studentPlayerId: eve.id, startsAt: at(2), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "slot_taken" });
    await expect(bookLesson(db, { coach, studentPlayerId: eve.id, startsAt: at(9), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "outside_hours" });
    expect(await studentStatus(db, coach.id, eve.id)).toBe("none");
  });

  it("lets somebody who walked away come back by booking again", async () => {
    const coach = await aCoach("Yara", true);
    const fin = await makePlayer(db, "Fin");
    await setStudentStatus(db, coach.id, fin.id, "left");
    await bookLesson(db, { coach, studentPlayerId: fin.id, startsAt: at(3), byCoach: false, source: "web" }, before);
    expect(await studentStatus(db, coach.id, fin.id)).toBe("accepted");
  });
});

/**
 * The coach's half of "anyone can book". A person they never had picks an hour and the coach answers
 * it; somebody who was on the list before never waits again; and a blocked person is out, whatever
 * door stands open and whatever link they hold.
 */
describe("a first booking the coach answers", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  const monday = new Date("2026-10-05T00:00:00.000Z");
  const at = (h: number) => new Date(monday.getTime() + h * HOUR);
  const before = new Date(monday.getTime() - 2 * HOUR);

  const aCoach = async (name: string, patch: { openBooking?: boolean; approveNewBookings?: boolean }) => {
    const p = await makePlayer(db, name);
    const coach = await createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("mornings") });
    return updateCoach(db, coach.id, patch);
  };

  it("turns a newcomer's pick into a request, and the coach's yes books it", async () => {
    const coach = await aCoach("Ada", { openBooking: true, approveNewBookings: true });
    const gil = await makePlayer(db, "Gil");
    const asked = await requestOrBook(db, coach, gil.id, at(1), null, before, { heads: 2 });
    expect(asked.kind).toBe("requested");
    // Nothing booked and nobody joined until the coach answers.
    expect(await studentStatus(db, coach.id, gil.id)).toBe("none");
    const open = await listOpenRequests(db, coach.id, before);
    expect(open.map((r) => r.player.displayName)).toEqual(["Gil"]);
    expect(open[0].heads).toBe(2);

    const { lesson } = await decideRequest(db, coach, open[0].id, true, before);
    expect(lesson?.startsAt.toISOString()).toBe(at(1).toISOString());
    // The coach asked for two, so the lesson is for two, and the yes is also the joining.
    expect(lesson?.heads).toBe(2);
    expect(await studentStatus(db, coach.id, gil.id)).toBe("accepted");
  });

  it("books straight through for somebody who was on the list before", async () => {
    const coach = await aCoach("Bea", { openBooking: true, approveNewBookings: true });
    const hana = await makePlayer(db, "Hana");
    // She took lessons and then removed the coach herself. Coming back is not a first booking.
    await setStudentStatus(db, coach.id, hana.id, "left");
    const again = await requestOrBook(db, coach, hana.id, at(1), null, before);
    expect(again.kind).toBe("booked");
    expect(await studentStatus(db, coach.id, hana.id)).toBe("accepted");
  });

  it("the coach's no closes it and leaves nobody on the list", async () => {
    const coach = await aCoach("Cleo", { openBooking: true, approveNewBookings: true });
    const ivo = await makePlayer(db, "Ivo");
    await requestOrBook(db, coach, ivo.id, at(2), null, before);
    const [open] = await listOpenRequests(db, coach.id, before);
    const { request, lesson } = await decideRequest(db, coach, open.id, false, before);
    expect([request.status, lesson]).toEqual(["declined", null]);
    expect(await studentStatus(db, coach.id, ivo.id)).toBe("none");
  });

  it("still books at once when the coach did not ask to answer first", async () => {
    const coach = await aCoach("Dita", { openBooking: true, approveNewBookings: false });
    const jo = await makePlayer(db, "Jo");
    const r = await requestOrBook(db, coach, jo.id, at(1), null, before);
    expect(r.kind).toBe("booked");
    expect(await studentStatus(db, coach.id, jo.id)).toBe("accepted");
  });

  it("shuts every door on somebody the coach blocked", async () => {
    const coach = await aCoach("Elsa", { openBooking: true, approveNewBookings: false });
    const kit = await makePlayer(db, "Kit");
    await setStudentStatus(db, coach.id, kit.id, "blocked");
    // The open door, the ask, the coach's own booking, and the link they were once sent.
    await expect(bookLesson(db, { coach, studentPlayerId: kit.id, startsAt: at(1), byCoach: false, source: "web" }, before)).rejects.toMatchObject({ code: "blocked" });
    await expect(bookLesson(db, { coach, studentPlayerId: kit.id, startsAt: at(1), byCoach: true, source: "web" }, before)).rejects.toMatchObject({ code: "blocked" });
    await expect(requestOrBook(db, coach, kit.id, at(9), null, before)).rejects.toMatchObject({ code: "blocked" });
    await expect(requestStudent(db, coach.id, kit.id)).rejects.toMatchObject({ code: "blocked" });
    await expect(acceptByInvite(db, coach.id, kit.id)).rejects.toMatchObject({ code: "blocked" });
    // The row stays, so the lessons they took and anything they owe stay with it.
    expect(await studentStatus(db, coach.id, kit.id)).toBe("blocked");
  });
});

/**
 * What a card may claim. A card is read by somebody deciding, so every line on it has to survive the
 * tap: a price the coach's page also shows, and a free hour that reader can actually take.
 */
describe("a card keeps what it promises", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";
  const monday = new Date("2026-10-05T00:00:00.000Z");
  const at = (h: number) => new Date(monday.getTime() + h * HOUR);
  const before = new Date(monday.getTime() - 2 * HOUR);

  const aCoach = async (name: string, patch: Parameters<typeof updateCoach>[2] = {}) => {
    const p = await makePlayer(db, name);
    const coach = await createCoach(db, { playerId: p.id, displayName: name, tz: TZ, hours: presetHours("mornings") });
    return Object.keys(patch).length ? updateCoach(db, coach.id, patch) : coach;
  };

  it("takes the hour out of the cheapest package when there is no single price", () => {
    // 7000 for ten is 700 an hour. 5000 for five is 1000. The cheaper hour wins, not the cheaper box.
    expect(packagePriceFrom([{ size: 10, price: 7000, heads: 1 }, { size: 5, price: 5000, heads: 1 }])).toEqual({ each: 700, size: 10 });
    // A package for two is a different thing being sold; it is not this coach's hourly rate.
    expect(packagePriceFrom([{ size: 10, price: 6000, heads: 2 }])).toBeNull();
    expect(packagePriceFrom([])).toBeNull();
  });

  it("shows a package hour to a coach who sells no single lessons, and nothing to a coach with neither", async () => {
    const packs = await aCoach("Vera", { openBooking: true });
    await saveOffers(db, packs.id, [{ size: 10, minutes: 60, heads: 1, price: 7000, validDays: 70 }]);
    const bare = await aCoach("Wim", { openBooking: true });
    const offers = await offersForCoaches(db, [packs.id, bare.id]);

    const packFacts = coachCardFacts(packs, NO_BUSY, offers.get(packs.id) ?? [], before);
    expect([packFacts.priceFrom, packFacts.packageFrom]).toEqual([null, { each: 700, size: 10 }]);
    // A coach with a single price does not also get a package line: one number on the card.
    const priced = await aCoach("Yuki", { openBooking: true, priceSingle: 1200 });
    await saveOffers(db, priced.id, [{ size: 10, minutes: 60, heads: 1, price: 7000, validDays: 70 }]);
    const pricedOffers = await offersForCoaches(db, [priced.id]);
    const pricedFacts = coachCardFacts(priced, NO_BUSY, pricedOffers.get(priced.id) ?? [], before);
    expect([pricedFacts.priceFrom, pricedFacts.packageFrom]).toEqual([1200, null]);
    // Neither: the card says nothing rather than pointing at a page that has nothing either.
    const bareFacts = coachCardFacts(bare, NO_BUSY, offers.get(bare.id) ?? [], before);
    expect([bareFacts.priceFrom, bareFacts.packageFrom]).toEqual([null, null]);
  });

  it("names a free hour only for a coach a stranger can actually book", async () => {
    const open = await aCoach("Zoe", { openBooking: true });
    const asks = await aCoach("Abe", { openBooking: false });
    // Both have the same empty week, so the only difference is whether the door is open.
    expect(coachCardFacts(open, NO_BUSY, [], before).nextFree).toBe(at(0).toISOString());
    expect(coachCardFacts(asks, NO_BUSY, [], before).nextFree).toBeNull();
    expect(coachCardFacts(asks, NO_BUSY, [], before).canBookNow).toBe(false);
  });
});
