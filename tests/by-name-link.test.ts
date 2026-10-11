import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { players, type Player } from "@/db/schema";
import { personalTokenFor } from "@/actions/shared";
import { GET as calendarFile } from "@/app/[code]/calendar.ics/route";
import { createEvent } from "@/lib/domain/events";
import { createPlayer } from "@/lib/domain/players";
import { rolodexForBrowser } from "@/lib/domain/queries";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";

/**
 * A session by name ("That's me", DECIDING rule 34) gets no personal link until the record proves
 * something: the link is a full sign-in, and it can be rotated to lock the real player out. My matches
 * and the manifest held it back. The organiser's share page (any match of one's own) and the match's
 * .ics download did not, until 11 October 2026. `personalTokenFor` is now the one door, and the .ics
 * passes `personalLink: false` for such a session.
 */
describe("a session by name gets no personal link from any screen or file", () => {
  let db: Db;
  let ana: Player;
  let org: Player;
  let code: string;
  const byName = () => ({ [PLAYER_COOKIE]: sealPlayerId(ana.id, { byName: true }) });
  const full = () => ({ [PLAYER_COOKIE]: sealPlayerId(ana.id) });

  beforeAll(async () => {
    db = await getDb();
    org = await createPlayer(db, { displayName: "Org", locale: "en" });
    ana = await createPlayer(db, { displayName: "Ana", locale: "en" });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + 2 * 86_400_000), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    code = ev.code;
  });

  const tokenOf = async () => (await db.select({ t: players.personalToken }).from(players).where(eq(players.id, ana.id)))[0]?.t ?? null;
  const ics = async (jar: Record<string, string>) => {
    const { result } = await asAction(jar, async () => (await calendarFile(new Request(`http://localhost/${code}/calendar.ics`), { params: Promise.resolve({ code }) })).text());
    return result;
  };

  it("personalTokenFor: none for a session by name, the token for a full one", async () => {
    const fresh = (await db.select().from(players).where(eq(players.id, ana.id)))[0];
    expect((await asAction(byName(), () => personalTokenFor(db, fresh))).result).toBeNull();
    // And none was minted for it.
    expect(await tokenOf()).toBeNull();
    const token = (await asAction(full(), () => personalTokenFor(db, fresh))).result;
    expect(token).toBeTruthy();
    expect(await tokenOf()).toBe(token);
  });

  it("the match's .ics carries the personal link for a full session and the public one for a session by name", async () => {
    const token = await tokenOf();
    expect(token).toBeTruthy();
    const mine = await ics(full());
    expect(mine).toContain(`/p/${token}`);
    const named = await ics(byName());
    expect(named).toContain("BEGIN:VCALENDAR");
    expect(named).not.toContain(`/p/${token}`);
    expect(named).not.toContain("/p/");
    expect(named).toContain(`/${code}`);
  });

  // Since the owner's decision of 11 October 2026, "That's me" signs in a record that organised only
  // past matches. As that organiser, a stranger opens the reserve form of a new match: its suggestions
  // are the people that record played with, and their emails and phones are not the stranger's to read.
  it("the organiser's suggestions carry names alone for a session by name: no email and no phone", () => {
    const list = [{ name: "Jo", email: "jo@example.com", phone: "+66810000000" }];
    expect(rolodexForBrowser(list, { namesAlone: true })).toEqual([{ name: "Jo", email: null, phone: null }]);
    expect(rolodexForBrowser(list, { namesAlone: false })).toEqual(list);
    // The match page hands the open spot only that shape, and asks the session's own mark for it.
    const page = readFileSync(path.resolve(process.cwd(), "src/app/[code]/page.tsx"), "utf8");
    expect(page).toContain("rolodexForBrowser(rolodex, { namesAlone })");
    expect(page).toContain("const namesAlone = reserving && (await nameOnly(me));");
    expect(page).not.toMatch(/rolodex\.map\(/);
  });

  it("no page, route or component in src/app or src/components mints a personal token itself", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.join(dir, e.name)] : []));
    // The push cron sends to a device, not to a browser session: it is no screen and holds no cookie.
    const allowed = new Set(["src/app/api/cron/push/route.ts"]);
    const found = ["src/app", "src/components"]
      .flatMap((d) => files(path.resolve(process.cwd(), d)))
      .map((f) => path.relative(process.cwd(), f))
      .filter((f) => !allowed.has(f) && readFileSync(f, "utf8").includes("getOrCreatePersonalToken("));
    expect(found, "hand the session its personal link through personalTokenFor (src/actions/shared.ts)").toEqual([]);
  });
});
