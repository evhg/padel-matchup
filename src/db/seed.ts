import { count } from "drizzle-orm";
import type { Db } from "./index";
import { activity, events, players, scores, slots, venues } from "./schema";
import { newInviteCode, newManageCode } from "@/lib/codes";
import { zonedTimeToUtc, tomorrowAt } from "@/lib/dates";

/**
 * Seeds an example upcoming match (code PLAY) and a finished match with a
 * result (code PAST) when the database has no events. Safe to call repeatedly.
 */
export async function seedIfEmpty(db: Db): Promise<boolean> {
  const [{ n }] = await db.select({ n: count() }).from(events);
  if (Number(n) > 0) return false;

  const tz = "Europe/Madrid";
  const [alex, maria, jordi, sofia] = await db
    .insert(players)
    .values([
      { displayName: "Alex", locale: "en", email: null },
      { displayName: "Maria", locale: "en" },
      { displayName: "Jordi", locale: "en" },
      { displayName: "Sofia", locale: "ru" },
    ])
    .returning();

  await db.insert(venues).values({
    creatorPlayerId: alex.id,
    name: "Padel Indoor BCN",
    mapUrl: "https://maps.google.com/?q=Padel+Indoor+BCN",
  });

  // Upcoming match: tomorrow 18:00, 2 joined, 1 reserved (invited), 1 open.
  const t = tomorrowAt(tz);
  const [upcoming] = await db
    .insert(events)
    .values({
      code: "PLAY",
      type: "match",
      title: "Thursday padel",
      startsAt: zonedTimeToUtc(t.date, t.time, tz),
      tz,
      venueName: "Padel Indoor BCN",
      venueMapUrl: "https://maps.google.com/?q=Padel+Indoor+BCN",
      capacity: 4,
      whenFull: "waitlist",
      note: "Court 3. Bring a yellow ball 🎾",
      creatorPlayerId: alex.id,
      manageCode: newManageCode(),
      status: "open",
    })
    .returning();

  await db.insert(slots).values([
    { eventId: upcoming.id, position: 1, playerId: alex.id, status: "joined", joinedAt: new Date() },
    { eventId: upcoming.id, position: 2, playerId: maria.id, status: "joined", joinedAt: new Date() },
    {
      eventId: upcoming.id,
      position: 3,
      kind: "reserved",
      status: "invited",
      invitedName: "Jordi",
      inviteCode: newInviteCode(),
      invitedAt: new Date(Date.now() - 2 * 24 * 3600 * 1000),
    },
    { eventId: upcoming.id, position: 4 },
  ]);

  await db.insert(activity).values([
    { eventId: upcoming.id, actorPlayerId: alex.id, verb: "created" },
    { eventId: upcoming.id, actorPlayerId: alex.id, verb: "joined" },
    { eventId: upcoming.id, actorPlayerId: maria.id, verb: "joined" },
    { eventId: upcoming.id, actorPlayerId: alex.id, verb: "invited", meta: { name: "Jordi" } },
  ]);

  // Finished match with a result (organizer-confirmed).
  const pastStart = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  const [past] = await db
    .insert(events)
    .values({
      code: "PAST",
      type: "match",
      title: null,
      startsAt: pastStart,
      tz,
      venueName: "Padel Indoor BCN",
      capacity: 4,
      whenFull: "closed",
      creatorPlayerId: alex.id,
      manageCode: newManageCode(),
      status: "past",
      scoreLockedByCreator: true,
      scoreReminderSent: true,
    })
    .returning();

  await db.insert(slots).values([
    { eventId: past.id, position: 1, playerId: alex.id, status: "joined", team: "a", joinedAt: pastStart },
    { eventId: past.id, position: 2, playerId: maria.id, status: "joined", team: "a", joinedAt: pastStart },
    { eventId: past.id, position: 3, playerId: jordi.id, status: "joined", team: "b", joinedAt: pastStart },
    { eventId: past.id, position: 4, playerId: sofia.id, status: "joined", team: "b", joinedAt: pastStart },
  ]);
  await db.insert(scores).values([
    { eventId: past.id, setNumber: 1, sideA: 6, sideB: 4, enteredByPlayerId: alex.id },
    { eventId: past.id, setNumber: 2, sideA: 3, sideB: 6, enteredByPlayerId: alex.id },
    { eventId: past.id, setNumber: 3, sideA: 7, sideB: 5, enteredByPlayerId: alex.id },
  ]);
  await db.insert(activity).values([
    { eventId: past.id, actorPlayerId: alex.id, verb: "created", createdAt: new Date(pastStart.getTime() - 86400000) },
    { eventId: past.id, actorPlayerId: alex.id, verb: "score_entered", createdAt: new Date(pastStart.getTime() + 7200000) },
  ]);

  return true;
}
