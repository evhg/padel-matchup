import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { eq, getTableColumns, is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import * as schema from "@/db/schema";
import {
  coachBlocks,
  coachManagers,
  coachOpenings,
  coachPackageOffers,
  coachStudents,
  coachWants,
  coaches,
  competitionCategories,
  competitionPairs,
  competitions,
  demandSignals,
  deviceHints,
  feedback,
  groupRequests,
  groups,
  joinRequests,
  lessonPackages,
  lessonRequests,
  lessonWaitlist,
  lessons,
  levelChecks,
  milestones,
  passkeys,
  players,
  pushSubscriptions,
  series,
  venues,
  type Player,
} from "@/db/schema";
import { GET as exportRoute } from "@/app/api/me/export/route";
import { PassportCard } from "@/components/PassportCard";
import { createEvent } from "@/lib/domain/events";
import { exportPlayerData } from "@/lib/domain/profile";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { catalogue, renderIn } from "./helpers/render";
import { DAY, makePlayer } from "./helpers/db";

/**
 * Two of the owner's decisions of 9 November 2026.
 *
 * "Export holds everything": "'Download my data' says 'everything' but leaves out wishes, feedback notes,
 * coach data, recovery email and more. Add them (about six more reads per export)." Every table with a
 * column about a player is named below, in the file or out of it with the reason; a new one fails the
 * first test until somebody decides.
 *
 * "Name-only session: no export": "A browser signed in by name only ('That's me') can download that
 * record's phone and email today. Refuse until it proves itself, as account deletion already does."
 */
const NOW = new Date(Date.UTC(2026, 10, 9, 4, 0));
freezeClock(NOW);

/** Each table with a column about a player, and where the export carries it. */
const IN: Record<string, string> = {
  players: "player",
  events: "matches (organizer; court_booked_by, a tap on somebody's match, stays out)",
  slots: "matches (seat, team)",
  groups: "groups",
  group_members: "groups",
  notices: "notices.inbox",
  passkeys: "phones",
  device_hints: "deviceHints (the label and two days; never the key, which is all the row keeps of the phone)",
  clubs: "clubs (claimed by the player; added_by, a public listing the player once added, stays out)",
  demand_signals: "wants",
  coach_wants: "coachWants",
  feedback: "feedback",
  group_requests: "asks.groups",
  join_requests: "asks.matches",
  level_checks: "levelChecks",
  coaches: "coach",
  coach_managers: "managesCoaches",
  coach_students: "lessons.coaches",
  lessons: "lessons.lessons, coach.lessons",
  lesson_packages: "lessons.packages",
  lesson_waitlist: "lessons.waitlist",
  lesson_requests: "lessons.requests",
  milestones: "milestones",
  push_subscriptions: "pushDevices (the browser in words and two days; never the endpoint or its keys)",
  venues: "courts",
  series: "series",
  competitions: "competitions.organised",
  competition_pairs: "competitions.entries (never the partner)",
};
/** Each table with a player column that stays out, and why. */
const OUT: Record<string, string> = {
  facts: "the fact log: counts with no name, each one about a match, a lesson or a sign-in the file already has",
  activity: "the match's own feed, which names the other players; each match is in the file with its link",
  scores: "the result of a match in the file (its outcome is there); entered_by is who typed it",
  tournament_matches: "the rounds of a night in the file, with the other players in them",
  competition_matches: "the draw of a competition, with the other pairs in it; entered_by is who typed a result",
  event_photos: "a photo on a match page: the match is in the file with its link",
};

let db: Db;
beforeAll(async () => {
  db = await getDb();
});

describe("every table about a player is in the file or out of it on purpose", () => {
  it("names each table with a player column, once", () => {
    const found = new Set<string>();
    for (const t of Object.values(schema)) {
      if (!is(t, PgTable)) continue;
      const cfg = getTableConfig(t);
      const byKey = cfg.foreignKeys.some((fk) => getTableConfig(fk.reference().foreignTable).name === "players");
      const byName = Object.values(getTableColumns(t)).some((c) => /(^|_)player_id$/.test(c.name));
      if (byKey || byName || cfg.name === "players") found.add(cfg.name);
    }
    for (const name of Object.keys(IN)) expect(OUT[name], name).toBeUndefined();
    expect([...found].sort()).toEqual([...Object.keys(IN), ...Object.keys(OUT)].sort());
  });
});

describe("the export holds every row about the player", () => {
  it("carries each table, and no credential and nobody else's name", async () => {
    const tag = randomUUID().slice(0, 6);
    const ana = await makePlayer(db, "Ana", { email: `ana-${tag}@example.com`, recoveryEmail: `old-${tag}@example.com`, telegramId: Number.parseInt(tag, 16) + 10_000_000, emailNotifications: false, phone: "+66 81 000 0000" });
    const ben = await makePlayer(db, `Benedikt ${tag}`);
    const ev = await createEvent(db, { creatorPlayerId: ben.id, type: "match", startsAt: new Date(NOW.getTime() + 3 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    const [crew] = await db.insert(groups).values({ code: `G${tag}`.toUpperCase().slice(0, 6), name: "Sunday crew", creatorPlayerId: ben.id, tz: "Asia/Bangkok" }).returning();
    const [coach] = await db.insert(coaches).values({ playerId: ana.id, handle: `ana${tag}`, displayName: "Coach Ana", tz: "Asia/Bangkok", inviteCode: `inv-${tag}`, managerCode: `mgr-${tag}`, icalUrl: `https://cal.example/secret-${tag}.ics`, whatsapp: "+66 81 111 1111" }).returning();
    const [other] = await db.insert(coaches).values({ playerId: ben.id, handle: `ben${tag}`, displayName: "Coach Ben", tz: "Asia/Bangkok" }).returning();
    const at = new Date(NOW.getTime() + 2 * DAY);
    await db.insert(demandSignals).values({ playerId: ana.id, weekday: 2, fromTime: "18:00", citySlug: "phuket", expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    await db.insert(coachWants).values({ playerId: ana.id, citySlug: "phuket", whenNote: "evenings", expiresAt: new Date(NOW.getTime() + 90 * DAY) });
    await db.insert(feedback).values({ source: "web", playerId: ana.id, name: "Ana", email: `ana-${tag}@example.com`, text: `More courts please ${tag}`, assessment: `internal-${tag}` });
    await db.insert(feedback).values({ source: "telegram", telegramUserId: ana.telegramId, name: "Ana", text: `From the bot ${tag}` });
    await db.insert(groupRequests).values({ groupId: crew.id, playerId: ana.id, note: "Can I join?" });
    await db.insert(joinRequests).values({ eventId: ev.id, playerId: ana.id, level: 3 });
    await db.insert(levelChecks).values({ playerId: ana.id, coachId: other.id, level: 3 });
    // Ana's own book: a lesson with Ben as the student, whose name stays out of Ana's file.
    await db.insert(lessons).values({ coachId: coach.id, studentPlayerId: ben.id, startsAt: at, minutes: 60, note: "Backhand" });
    await db.insert(coachPackageOffers).values({ coachId: coach.id, size: 10, minutes: 60, price: 9000 });
    await db.insert(coachBlocks).values({ coachId: coach.id, startsAt: at, endsAt: new Date(at.getTime() + 3600_000), reason: "Dentist" });
    await db.insert(coachOpenings).values({ coachId: coach.id, startsAt: at, endsAt: new Date(at.getTime() + 3600_000) });
    // Ana as Ben's student and as the manager of his book.
    await db.insert(coachManagers).values({ coachId: other.id, playerId: ana.id });
    await db.insert(coachStudents).values({ coachId: other.id, playerId: ana.id, status: "accepted" });
    await db.insert(lessons).values({ coachId: other.id, studentPlayerId: ana.id, startsAt: at, minutes: 90 });
    await db.insert(lessonPackages).values({ coachId: other.id, studentPlayerId: ana.id, size: 5 });
    await db.insert(lessonWaitlist).values({ coachId: other.id, studentPlayerId: ana.id, slotStartsAt: at });
    await db.insert(lessonRequests).values({ coachId: other.id, studentPlayerId: ana.id, startsAt: at, minutes: 60, note: "Early please" });
    await db.insert(milestones).values({ playerId: ana.id, kind: "matches_10", value: "10" });
    await db.insert(pushSubscriptions).values({ playerId: ana.id, endpoint: `https://push.example/${tag}`, p256dh: `p256-${tag}`, auth: `auth-${tag}`, userAgent: "iPhone, Safari" });
    await db.insert(venues).values({ creatorPlayerId: ana.id, name: "Rawai Padel", mapUrl: "https://maps.app.goo.gl/r" });
    await db.insert(series).values({ slug: `fri-${tag}`, name: "Friday nights", organizerPlayerId: ana.id, tz: "Asia/Bangkok", capacity: 8, dow: 5, time: "19:00", anchorAt: at });
    const [cup] = await db.insert(competitions).values({ slug: `cup-${tag}`, name: "Phuket Cup", organizerPlayerId: ana.id, tz: "Asia/Bangkok", startsOn: "2026-12-01", endsOn: "2026-12-02" }).returning();
    const [cat] = await db.insert(competitionCategories).values({ competitionId: cup.id, name: "Mixed" }).returning();
    await db.insert(competitionPairs).values({ categoryId: cat.id, competitionId: cup.id, p1PlayerId: ben.id, p2PlayerId: ana.id, position: 1, claimToken: `claim-${tag}` });
    await db.insert(passkeys).values({ id: `cred-${tag}`, playerId: ana.id, publicKey: `pk-${tag}`, deviceType: "multiDevice", label: "iPhone, Safari" });
    await db.insert(deviceHints).values({ playerId: ana.id, key: `hintkey-${tag}`, label: "iPhone" });

    const me = (await db.select().from(players).where(eq(players.id, ana.id)))[0];
    const data = await exportPlayerData(db, me, "https://kicksma.sh", NOW);

    // The rest of the player's row, the audit's list first.
    expect(data.player).toMatchObject({ recoveryEmail: `old-${tag}@example.com`, telegramId: ana.telegramId, emailNotifications: false, phone: "+66 81 000 0000", banter: true });
    // One line per table, each with the row this test wrote.
    expect(data.wants).toMatchObject([{ weekday: 2, fromTime: "18:00", city: "phuket" }]);
    expect(data.coachWants).toMatchObject([{ city: "phuket", when: "evenings" }]);
    expect(data.feedback.map((f) => f.text).sort()).toEqual([`From the bot ${tag}`, `More courts please ${tag}`]);
    expect(data.feedback.find((f) => f.source === "web")).toMatchObject({ name: "Ana", email: `ana-${tag}@example.com` });
    expect(data.asks.groups).toMatchObject([{ group: crew.code, name: "Sunday crew", note: "Can I join?", status: "pending" }]);
    expect(data.asks.matches).toMatchObject([{ match: ev.code, level: 3, status: "pending" }]);
    expect(data.levelChecks).toMatchObject([{ coach: other.handle, status: "pending", level: 3 }]);
    expect(data.coach).toMatchObject({ handle: coach.handle, url: `https://kicksma.sh/c/${coach.handle}`, whatsapp: "+66 81 111 1111" });
    expect(data.coach?.lessons).toMatchObject([{ minutes: 60, note: "Backhand" }]);
    expect(data.coach?.offers).toMatchObject([{ size: 10, price: 9000 }]);
    expect(data.coach?.blocked).toMatchObject([{ reason: "Dentist" }]);
    expect(data.coach?.opened).toHaveLength(1);
    expect(data.managesCoaches).toMatchObject([{ coach: other.handle }]);
    expect(data.lessons.coaches).toMatchObject([{ coach: other.handle, status: "accepted" }]);
    expect(data.lessons.lessons).toMatchObject([{ coach: other.handle, minutes: 90 }]);
    expect(data.lessons.packages).toMatchObject([{ coach: other.handle, size: 5 }]);
    expect(data.lessons.waitlist).toMatchObject([{ coach: other.handle, status: "waiting" }]);
    expect(data.lessons.requests).toMatchObject([{ coach: other.handle, note: "Early please" }]);
    expect(data.milestones).toMatchObject([{ kind: "matches_10", value: "10" }]);
    expect(data.pushDevices).toMatchObject([{ device: "iPhone, Safari" }]);
    expect(data.courts).toMatchObject([{ name: "Rawai Padel", mapUrl: "https://maps.app.goo.gl/r" }]);
    expect(data.series).toEqual([{ slug: `fri-${tag}`, name: "Friday nights", url: `https://kicksma.sh/s/fri-${tag}` }]);
    expect(data.competitions.organised).toEqual([{ slug: `cup-${tag}`, name: "Phuket Cup", url: `https://kicksma.sh/t/cup-${tag}` }]);
    expect(data.competitions.entries).toMatchObject([{ competition: `cup-${tag}`, status: "entered" }]);
    expect(data.deviceHints).toMatchObject([{ label: "iPhone" }]);

    // No credential, no internal triage, and nobody else's name.
    const raw = JSON.stringify(data);
    const never = [`inv-${tag}`, `mgr-${tag}`, `secret-${tag}`, `https://push.example/${tag}`, `p256-${tag}`, `auth-${tag}`, `claim-${tag}`, `cred-${tag}`, `pk-${tag}`, `hintkey-${tag}`, `internal-${tag}`, `Benedikt ${tag}`];
    expect(never.filter((x) => raw.includes(x))).toEqual([]);
  });
});

describe("a session by name that proved nothing gets no file", () => {
  const byName = (p: Player) => ({ [PLAYER_COOKIE]: sealPlayerId(p.id, { byName: true }) });
  const full = (p: Player) => ({ [PLAYER_COOKIE]: sealPlayerId(p.id) });

  it("refuses it with the deletion's answer and its words, and gives the file to the same record once it proves itself", async () => {
    const tim = await makePlayer(db, "Tim", { phone: null, email: `tim-${randomUUID().slice(0, 6)}@example.com` });
    const refused = (await asAction(byName(tim), () => exportRoute())).result;
    expect(refused.status).toBe(403);
    const body = await refused.json();
    expect(body.error.code).toBe("proof_required");
    expect(body.error.message).toContain("prove it is yours");
    expect(JSON.stringify(body)).not.toContain(tim.email!);
    // The full session of the same record downloads.
    const ok = (await asAction(full(tim), () => exportRoute())).result;
    expect(ok.status).toBe(200);
    expect((await ok.json()).player.email).toBe(tim.email);
    // A session by name whose record proved something (a linked Telegram) is a full one, as for the deletion.
    const tia = await makePlayer(db, "Tia", { telegramId: 7_000_000 + Math.floor(Math.random() * 1_000_000) });
    expect((await asAction(byName(tia), () => exportRoute())).result.status).toBe(200);
  });

  it("My matches shows why and the doors that prove it, in place of the download, in every language", () => {
    const card = (byName: "both" | "email" | "telegram" | "other" | null, l: "en" | "ru" | "es" = "en") => renderIn(l, createElement(PassportCard, { publicOn: false, slug: null, base: "https://kicksma.sh", byName }));
    expect(card(null)).toContain('href="/api/me/export"');
    for (const l of ["en", "ru", "es"] as const) {
      const html = card("both", l);
      expect(html, l).not.toContain("/api/me/export");
      expect(html, l).toContain('data-testid="export-by-name"');
      // The same opening as the deletion's line: why this browser may not.
      const passport = catalogue(l).passport as Record<string, string>;
      const me = catalogue(l).me as Record<string, string>;
      expect(passport.exportByName.split(",")[0], l).toBe(me.deleteByName.split(",")[0]);
      expect(html, l).toContain("Telegram");
    }
    expect(card("other")).toContain("Download it from the browser where you first joined.");
  });
});
