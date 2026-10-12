import { eq } from "drizzle-orm";
import { createElement } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { clubs, coachManagers, coaches } from "@/db/schema";
import { createCoach, setStudentStatus } from "@/lib/domain/coaching";
import { NO_ROLES, roleCount, rolesFor } from "@/lib/domain/roles";
import { createTestDb, makePlayer } from "./helpers/db";
import { HeaderNav, updatesLabel } from "@/components/AssistantLink";
import { createTranslator } from "next-intl";
import { catalogue, renderIn } from "./helpers/render";

/**
 * The role set is what replaced the browser cookie that told a player they were a coach.
 * These are the cases that cookie got wrong.
 */
describe("the role set", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  const TZ = "Asia/Bangkok";

  it("gives a visitor with no identity nothing, without asking the database", async () => {
    expect(await rolesFor(db, null)).toEqual(NO_ROLES);
    expect(await rolesFor(db, undefined)).toEqual(NO_ROLES);
    expect(roleCount(NO_ROLES)).toBe(0);
  });

  it("gives a plain player nothing but Play", async () => {
    const p = await makePlayer(db, "Erik");
    const roles = await rolesFor(db, p.id);
    expect(roles).toEqual(NO_ROLES);
    expect(roleCount(roles)).toBe(0);
  });

  it("finds the coach's own book, and the book of a coach they only run", async () => {
    const anna = await makePlayer(db, "Anna");
    const annaCoach = await createCoach(db, { playerId: anna.id, displayName: "Anna", clubNames: ["Warehaus"], tz: TZ });
    expect(await rolesFor(db, anna.id)).toMatchObject({ coach: { handle: annaCoach.handle, as: "coach" } });

    const bee = await makePlayer(db, "Bee");
    await db.insert(coachManagers).values({ coachId: annaCoach.id, playerId: bee.id });
    const managed = await rolesFor(db, bee.id);
    expect(managed.coach).toEqual({ handle: annaCoach.handle, as: "manager" });
    expect(roleCount(managed)).toBe(1);
  });

  it("lists the clubs a person claimed, by name, and counts the coaches they study under", async () => {
    const sam = await makePlayer(db, "Sam");
    await db.insert(clubs).values([
      { slug: "rawai-padel", name: "Rawai Padel", city: "Phuket", claimedBy: sam.id, manageToken: "tok-rawai-000000" },
      { slug: "aonang-padel", name: "Ao Nang Padel", city: "Krabi", claimedBy: sam.id, manageToken: "tok-aonang-00000" },
    ]);
    const nokPlayer = await makePlayer(db, "Nok");
    const nok = await createCoach(db, { playerId: nokPlayer.id, displayName: "Nok", tz: TZ });
    await setStudentStatus(db, nok.id, sam.id, "accepted");

    const roles = await rolesFor(db, sam.id);
    expect(roles.clubs).toEqual([
      { slug: "aonang-padel", name: "Ao Nang Padel" },
      { slug: "rawai-padel", name: "Rawai Padel" },
    ]);
    expect(roles.studentOf).toBe(1);
    // Studying under a coach is not a door in the header; it is a block inside My matches.
    expect(roleCount(roles)).toBe(2);
  });

  it("drops a club whose claim was refused, and keeps the ones that were not", async () => {
    // A refused claimant kept the club door in the header, and it led to a page that told them the
    // claim failed and to write on GitHub. They are a player again: the header says My matches.
    const zoe = await makePlayer(db, "Zoe");
    await db.insert(clubs).values([
      { slug: "kamala-padel", name: "Kamala Padel", city: "Phuket", claimedBy: zoe.id, manageToken: "tok-kamala-00000", rejectedAt: new Date("2026-09-20T09:45:00Z") },
      { slug: "layan-padel", name: "Layan Padel", city: "Phuket", claimedBy: zoe.id, manageToken: "tok-layan-000000" },
    ]);
    const roles = await rolesFor(db, zoe.id);
    expect(roles.clubs).toEqual([{ slug: "layan-padel", name: "Layan Padel" }]);
    expect(roleCount(roles)).toBe(1);
  });

  it("does not count a student who only asked, or one the coach paused", async () => {
    const asker = await makePlayer(db, "Asker");
    const cp = await makePlayer(db, "Coach Two");
    const coach = await createCoach(db, { playerId: cp.id, displayName: "Coach Two", tz: TZ });
    await setStudentStatus(db, coach.id, asker.id, "requested");
    expect((await rolesFor(db, asker.id)).studentOf).toBe(0);
    await setStudentStatus(db, coach.id, asker.id, "paused");
    expect((await rolesFor(db, asker.id)).studentOf).toBe(0);
    await setStudentStatus(db, coach.id, asker.id, "accepted");
    expect((await rolesFor(db, asker.id)).studentOf).toBe(1);
  });

  it("stops calling someone a coach the moment the book is archived", async () => {
    const gone = await makePlayer(db, "Gone");
    const coach = await createCoach(db, { playerId: gone.id, displayName: "Gone", tz: TZ });
    expect((await rolesFor(db, gone.id)).coach).not.toBeNull();
    await db.update(coaches).set({ archivedAt: new Date() }).where(eq(coaches.id, coach.id));
    // This is the case the cookie could never see: the role ended, the browser did not hear.
    expect((await rolesFor(db, gone.id)).coach).toBeNull();
  });
});

/**
 * The owner, 12 October 2026, on her own match page at 390 px: "the two notifications in top signifies
 * what? Already one upcoming match." A bare "2" on "My matches" read as a count of matches. The unread
 * notices now wear a bell, and are a link of their own, named "2 new updates", to the inbox on My matches;
 * "My matches" is still exactly what its link is called.
 */
describe("the header's unread notices", () => {
  const labels = { myMatches: "My matches", assistant: "Assistant", club: "Club", series: "Series", more: "More", findGame: "Find a game", coaches: "Coaches", clubs: "Clubs", tournaments: "Tournaments", biggerText: "Bigger text", updates: "2 new updates" };
  const header = (roles: Partial<typeof NO_ROLES>) => renderIn("en", createElement(HeaderNav, { roles: { ...NO_ROLES, ...roles }, labels }));
  const links = (html: string) => [...html.matchAll(/<a\b([^>]*)>(.*?)<\/a>/g)].map((m) => ({ attrs: m[1], text: m[2].replace(/<[^>]+>/g, "") }));

  it("names the count as updates, links it to the inbox, and leaves \"My matches\" its own name", () => {
    const html = header({ unread: 2 });
    const bell = links(html).find((l) => l.attrs.includes('data-testid="nav-unread"'));
    expect(bell?.attrs).toContain('aria-label="2 new updates"');
    expect(bell?.attrs).toContain('href="/me#inbox"');
    expect(bell?.text).toBe("2");
    expect(links(html).find((l) => l.attrs.includes('data-testid="nav-play"'))?.text).toBe("My matches");
  });

  it("shows nothing when every notice is read", () => {
    expect(header({ unread: 0 })).not.toContain("nav-unread");
  });

  /**
   * Review, 12 October 2026: beside a coach's "🎾 My assistant" the bell took width, so at 390 px the word
   * Kicksmash was cut to "Kicks…" (and "Kic…" in Russian), and its number read as a count for the
   * assistant. The bell is pinned to a corner in every arrangement, so it takes no width: on "My matches"
   * when that door is outside, and on the menu's ⋯ otherwise, never on a role's door.
   */
  it("pins the bell to a corner in every arrangement: on My matches or on the menu, never beside a role door", () => {
    const coach = { handle: "olga", as: "coach" as const };
    const club = { slug: "warehaus", name: "Warehaus" };
    const arrangements: { roles: Partial<typeof NO_ROLES>; current?: "play" | "coach" | "club" | "series"; on: "play" | "menu" }[] = [
      { roles: {}, on: "play" },
      { roles: {}, current: "play", on: "play" },
      { roles: { coach }, on: "menu" },
      { roles: { coach }, current: "play", on: "menu" },
      { roles: { coach }, current: "coach", on: "play" },
      { roles: { clubs: [club] }, on: "menu" },
      { roles: { coach, clubs: [club] }, on: "menu" },
    ];
    for (const a of arrangements) {
      const html = renderIn("en", createElement(HeaderNav, { roles: { ...NO_ROLES, unread: 2, ...a.roles }, current: a.current, labels }));
      const bell = links(html).find((l) => l.attrs.includes('data-testid="nav-unread"'));
      const where = JSON.stringify({ roles: Object.keys(a.roles), current: a.current });
      expect(bell?.attrs, where).toMatch(/class="[^"]*\babsolute\b/);
      // The bell comes right after the thing it is pinned to, inside one positioned box.
      const pinnedTo = a.on === "play" ? /<span class="relative inline-flex"><a [^>]*data-testid="nav-play"[^>]*>My matches<\/a><a [^>]*data-testid="nav-unread"/ : /<span class="relative inline-flex"><details[\s\S]*?<\/details><a [^>]*data-testid="nav-unread"/;
      expect(html, where).toMatch(pinnedTo);
    }
  });

  it("keeps the bell outside the menu when \"My matches\" waits inside it", () => {
    const html = header({ unread: 3, coach: { handle: "olga", as: "coach" } });
    const menu = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
    expect(html.indexOf('data-testid="nav-unread"')).toBeGreaterThan(-1);
    expect(menu).not.toContain('data-testid="nav-unread"');
  });

  /**
   * Review, 12 October 2026: in a Russian interface "обновление" is an update of the app. The bell's
   * name in Russian is "2 новых уведомления", as notices are called everywhere else in Russian.
   */
  it("names the bell as notices in Russian, never as app updates", () => {
    const ru = (n: number) => updatesLabel(createTranslator({ locale: "ru", messages: catalogue("ru") as never }) as never, n);
    expect([1, 3, 5, 12].map(ru)).toEqual(["1 новое уведомление", "3 новых уведомления", "5 новых уведомлений", "Больше 9 новых уведомлений"]);
    const en = (n: number) => updatesLabel(createTranslator({ locale: "en", messages: catalogue("en") as never }) as never, n);
    expect([1, 2, 12].map(en)).toEqual(["1 new update", "2 new updates", "More than 9 new updates"]);
  });
});
