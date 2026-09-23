import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { coachStudents, coaches, feedback, groupMembers, lessonPackages, lessons, players, pushSubscriptions } from "@/db/schema";
import { createGroup } from "@/lib/domain/groups";
import { mergePlayers, playerReferences } from "@/lib/domain/merge";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * A merge moves everything that points at a person, and loses nothing.
 *
 * On 23 September 2026 four merges ran in production and a note's author went blank: the merge moved
 * matches, slots, scores, tournaments, activity and venues, then deleted the old rows, and every
 * other table followed the delete — `on delete cascade` took rows with it, `set null` blanked links.
 * A student merged that way left the coach's list and took their packages with them. These cases are
 * the ones that broke, and one clash of each kind a move can meet.
 */

const coachFor = async (db: Awaited<ReturnType<typeof createTestDb>>["db"], playerId: string, handle: string) =>
  (await db.insert(coaches).values({ playerId, handle, displayName: handle, tz: "Asia/Bangkok", clubNames: [], clubSlugs: [], hours: {} }).returning())[0];

describe("merging two rows of one person", () => {
  it("moves the rows a delete would have taken or blanked", async () => {
    const { db } = await createTestDb();
    const erik = await makePlayer(db, "Erik");
    const dup = await makePlayer(db, "Erik", { telegramId: 1248577943 });
    const nok = await makePlayer(db, "Nok");
    const coach = await coachFor(db, nok.id, "nok");
    const [note] = await db.insert(feedback).values({ source: "web", playerId: dup.id, name: "Erik", text: "does this merge?", locale: "en" }).returning();
    await db.insert(pushSubscriptions).values({ playerId: dup.id, endpoint: "https://push.example/dup", p256dh: "k", auth: "a" });
    await db.insert(coachStudents).values({ coachId: coach.id, playerId: dup.id, status: "accepted" });
    const [pkg] = await db.insert(lessonPackages).values({ coachId: coach.id, studentPlayerId: dup.id, size: 10 }).returning();
    const [lesson] = await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: dup.id, startsAt: new Date(Date.UTC(2026, 9, 1, 2)), minutes: 60, status: "booked", amount: 800 }).returning();

    await mergePlayers(db, erik.id, [dup.id]);

    expect((await db.select().from(feedback).where(eq(feedback.id, note.id)))[0].playerId).toBe(erik.id); // set null, before
    expect(await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.playerId, erik.id))).toHaveLength(1); // cascade, before
    expect(await db.select().from(coachStudents).where(eq(coachStudents.playerId, erik.id))).toHaveLength(1); // cascade, before
    expect((await db.select().from(lessonPackages).where(eq(lessonPackages.id, pkg.id)))[0]?.studentPlayerId).toBe(erik.id); // cascade, before
    expect((await db.select().from(lessons).where(eq(lessons.id, lesson.id)))[0].studentPlayerId).toBe(erik.id); // set null, before
    // The duplicate's Telegram comes along, once the duplicate no longer holds it.
    const [after] = await db.select().from(players).where(eq(players.id, erik.id));
    expect(after.telegramId).toBe(1248577943);
    expect(await db.select().from(players).where(eq(players.id, dup.id))).toEqual([]);
  });

  it("keeps the survivor's row where both would share a key", async () => {
    const { db } = await createTestDb();
    const erik = await makePlayer(db, "Erik");
    const dup = await makePlayer(db, "Erik");
    const both = await createGroup(db, { name: "Rawai crew", creatorPlayerId: erik.id, tz: "Asia/Bangkok", memberIds: [dup.id] });
    const onlyDup = await createGroup(db, { name: "Tuesday", creatorPlayerId: dup.id, tz: "Asia/Bangkok" });

    await mergePlayers(db, erik.id, [dup.id]);

    const mine = await db.select().from(groupMembers).where(eq(groupMembers.playerId, erik.id));
    expect(mine.map((m) => m.groupId).sort()).toEqual([both.id, onlyDup.id].sort());
    expect(await db.select().from(groupMembers).where(eq(groupMembers.playerId, dup.id))).toEqual([]);
  });

  it("refuses two coach pages, because folding one would delete its lessons", async () => {
    const { db } = await createTestDb();
    const a = await makePlayer(db, "Nok");
    const b = await makePlayer(db, "Nok");
    await coachFor(db, a.id, "nok-a");
    await coachFor(db, b.id, "nok-b");
    await expect(mergePlayers(db, a.id, [b.id])).rejects.toThrow();
    // Nothing moved: the transaction is whole or nothing.
    expect(await db.select().from(players).where(eq(players.id, b.id))).toHaveLength(1);
  });

  it("knows every table that points at a player, from the schema", () => {
    const refs = playerReferences().map((r) => `${r.table}.${r.column}`);
    // The ones that lost data on 23 September, and the ones the old list did move.
    for (const r of ["feedback.player_id", "push_subscriptions.player_id", "coach_students.player_id", "lesson_packages.student_player_id", "lessons.student_player_id", "group_members.player_id", "clubs.claimed_by", "events.creator_player_id", "slots.player_id"]) {
      expect(refs, r).toContain(r);
    }
    expect(refs.length).toBeGreaterThan(30);
    const members = playerReferences().find((r) => r.table === "group_members" && r.column === "player_id")!;
    expect(members.uniqueWith).toContainEqual(["group_id"]);
  });
});
