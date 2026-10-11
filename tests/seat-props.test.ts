import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { slots, type Player } from "@/db/schema";
import { saveScoreAction } from "@/actions/scores";
import { createEvent, isOccupied } from "@/lib/domain/events";
import { createPlayer } from "@/lib/domain/players";
import { getEventByCode, type EventDetail } from "@/lib/domain/queries";
import { joinEvent } from "@/lib/domain/slots";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { playersOfSeats, scorePlayers, seatOfPlayer } from "@/lib/seatProps";
import { asAction } from "./helpers/action";

/**
 * The match page goes to every viewer of a started match, and until 11 October 2026 its score panel
 * carried the id of every seated player, while a player id signed a browser in (`restoreIdentity`). The
 * panel now carries seat ids, and the score action finds the players behind them on the server.
 */
describe("what the match page hands its score panel", () => {
  let db: Db;
  let org: Player;
  let people: Player[];
  let detail: EventDetail;
  beforeAll(async () => {
    db = await getDb();
    org = await createPlayer(db, { displayName: "Olga", locale: "en" });
    people = [await createPlayer(db, { displayName: "Ana", locale: "en" }), await createPlayer(db, { displayName: "Bo", locale: "en" }), await createPlayer(db, { displayName: "Cy", locale: "en" })];
    // Started half an hour ago, 90 minutes long: the panel shows, and the score may be typed.
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() - 30 * 60_000), tz: "UTC", venueName: "Rawai", whenFull: "closed" });
    // The organiser plays, as the create form's own join seats them.
    for (const p of [org, ...people]) await joinEvent(db, { eventId: ev.id, playerId: p.id, now: new Date(Date.now() - 60 * 60_000) });
    detail = (await getEventByCode(db, ev.code))!;
  });

  it("carries seat ids, names, sides and levels, and no player id", () => {
    const seated = detail.roster.filter(isOccupied);
    expect(seated).toHaveLength(4);
    const props = scorePlayers(seated);
    const json = JSON.stringify(props);
    for (const p of [org, ...people]) expect(json).not.toContain(p.id);
    expect(props.map((p) => p.id).sort()).toEqual(seated.map((s) => s.id).sort());
    expect(props.map((p) => p.name).sort()).toEqual(["Ana", "Bo", "Cy", "Olga"]);
  });

  it("maps seat ids back to this match's players only, and a player id finds nobody", () => {
    const seated = detail.roster.filter(isOccupied);
    const seatOf = seatOfPlayer(seated);
    expect(playersOfSeats(detail.roster, [seatOf.get(people[0].id), seatOf.get(people[1].id)])).toEqual([people[0].id, people[1].id]);
    expect(playersOfSeats(detail.roster, [people[0].id, people[1].id])).toEqual([]);
    expect(playersOfSeats(detail.roster, [42, null, "x"])).toEqual([]);
  });

  it("the score action sets the sides from two seat ids, as the panel sends them", async () => {
    const seatOf = seatOfPlayer(detail.roster);
    const teamA = [seatOf.get(org.id)!, seatOf.get(people[1].id)!];
    const { result } = await asAction({ [PLAYER_COOKIE]: sealPlayerId(people[0].id) }, () => saveScoreAction(detail.event.code, [{ setNumber: 1, sideA: 6, sideB: 4 }], teamA));
    expect(result).toEqual({ ok: true, data: null });
    const sides = new Map((await db.select({ playerId: slots.playerId, team: slots.team }).from(slots).where(eq(slots.eventId, detail.event.id))).map((r) => [r.playerId, r.team]));
    expect([sides.get(org.id), sides.get(people[1].id), sides.get(people[0].id), sides.get(people[2].id)]).toEqual(["a", "a", "b", "b"]);
    // Player ids in place of seat ids change no side: the action reads seats of this match only.
    await asAction({ [PLAYER_COOKIE]: sealPlayerId(people[0].id) }, () => saveScoreAction(detail.event.code, [{ setNumber: 1, sideA: 6, sideB: 3 }], [people[0].id, people[2].id]));
    const after = new Map((await db.select({ playerId: slots.playerId, team: slots.team }).from(slots).where(eq(slots.eventId, detail.event.id))).map((r) => [r.playerId, r.team]));
    expect(after).toEqual(sides);
  });
});

/**
 * A React key travels to the browser in the page's payload, even the key of a row a server component
 * draws. The tables of standings and the crew's list were keyed by player id; this holds the line in the
 * source. The coach's own screens are the one place a player id may stay: they go to the coach who
 * teaches those students and to nobody else, and every action behind them checks that tie again.
 */
describe("no React key is a player id", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(path.join(dir, f)).isDirectory() ? files(path.join(dir, f)) : f.endsWith(".tsx") ? [path.join(dir, f)] : []));
  it("in any page or component a stranger can open", () => {
    const allowed = /src\/components\/coach\//;
    const bad = [...files("src/app"), ...files("src/components")]
      .filter((f) => !allowed.test(f.replace(/\\/g, "/")))
      .flatMap((f) => readFileSync(f, "utf8").split("\n").flatMap((line, i) => (/key=\{[^}]*(playerId|player\.id|player!\.id)/.test(line) ? [`${f}:${i + 1}`] : [])));
    expect(bad).toEqual([]);
  });
});
