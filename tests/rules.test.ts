import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { coaches, events, players } from "@/db/schema";
import { mcpToolNames } from "@/lib/api/mcp";
import { openapiDocument } from "@/lib/api/openapi";
import { boardToPublic, clubToPublic, coachToPublic, groupToPublic, matchToPublic, seriesPageToPublic, seriesToPublic } from "@/lib/api/serialize";
import { claimClub, decideClub, getClub } from "@/lib/domain/clubs";
import { createCoach, presetHours } from "@/lib/domain/coaching";
import { createEvent } from "@/lib/domain/events";
import { createGroup, getGroupDetail } from "@/lib/domain/groups";
import { getOrCreatePersonalToken } from "@/lib/domain/identity";
import { createPlayer } from "@/lib/domain/players";
import { getEventByCode } from "@/lib/domain/queries";
import { createSeriesFromEvent, seriesPage } from "@/lib/domain/series";
import { reserveSlot } from "@/lib/domain/slots";
import { getVenueBoard, venueSlug } from "@/lib/domain/venueBoard";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY } from "./helpers/db";

/**
 * The rules AGENTS.md lists, checked by a machine instead of a reviewer: every public API route is
 * documented, every MCP tool is named on every surface that lists tools, and the public shapes carry
 * first names and levels only.
 */

/** Tuesday 8 September 2026, 16:00 in Phuket. */
const NOW = new Date("2026-09-08T09:00:00Z");
freezeClock(NOW);
const BASE = "https://kicksma.sh";
const root = (...p: string[]) => path.resolve(process.cwd(), ...p);

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? routeFiles(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : []));
}

describe("the public API is documented", () => {
  it("every route under src/app/api/v1 is an OpenAPI path, and every OpenAPI path is a route", () => {
    const dir = root("src/app/api/v1");
    const routes = routeFiles(dir)
      .map((f) => "/api/v1/" + path.relative(dir, path.dirname(f)).split(path.sep).map((seg) => seg.replace(/^\[(.+)\]$/, "{$1}")).join("/"))
      .sort();
    const documented = Object.keys(openapiDocument(BASE).paths).sort();
    expect(routes).toEqual(documented);
  });
});

describe("every surface that lists MCP tools lists all of them", () => {
  const surfaces = ["skills/kicksmash/SKILL.md", "src/app/developers/page.tsx", "docs/launch/directories.md"];
  for (const file of surfaces) {
    it(file, () => {
      const text = readFileSync(root(file), "utf8");
      const missing = mcpToolNames().filter((name) => !text.includes(name));
      expect(missing).toEqual([]);
    });
  }
});

describe("public shapes", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => ({ db, close } = await createTestDb()));
  afterAll(() => close());

  it("carry first names and levels, never an email, a phone, a token, a manage code or a payment id", async () => {
    // Every secret the rows can carry, each with a value that cannot appear by accident.
    const secret: Record<string, string> = {
      organizerEmail: "leak-organizer@example.com",
      organizerPhone: "+66 800 000 001",
      recoveryEmail: "leak-recovery@example.com",
      previousToken: "LEAKPREVTOKEN",
      telegramId: "424242424",
      discordId: "99999999999",
      guestEmail: "leak-guest@example.com",
      guestPhone: "+66 800 000 002",
      payNote: "PromptPay 0800000003 LEAK",
      coachEmail: "leak-coach@example.com",
      coachPhone: "+66 800 000 005",
      promptpay: "0800000004",
      payLink: "https://pay.example/LEAK-LINK",
      coachInvite: "LEAKINV",
    };

    const org = await createPlayer(db, { displayName: "Org", locale: "en", email: secret.organizerEmail, phone: secret.organizerPhone });
    secret.personalToken = await getOrCreatePersonalToken(db, org.id);
    await db.update(players).set({ recoveryEmail: secret.recoveryEmail, previousToken: secret.previousToken, telegramId: Number(secret.telegramId), discordId: secret.discordId }).where(eq(players.id, org.id));

    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Leak Padel Club", whenFull: "waitlist", publicListing: true, cost: "400 THB", payNote: secret.payNote, bookingUrl: "https://playtomic.io/leak" });
    secret.manageCode = ev.manageCode;
    const { slot } = await reserveSlot(db, { eventId: ev.id, actorPlayerId: org.id, name: "Guest", email: secret.guestEmail, phone: secret.guestPhone, now: NOW });
    if (slot.inviteCode) secret.inviteCode = slot.inviteCode;
    const detail = await getEventByCode(db, ev.code);
    expect(detail).not.toBeNull();
    // The fixture bites: the private detail does carry the secrets the public shape must drop.
    expect(JSON.stringify(detail)).toContain(secret.guestEmail);

    const group = await createGroup(db, { name: "Leak crew", creatorPlayerId: org.id, tz: "Asia/Bangkok", venueName: "Leak Padel Club", memberIds: [org.id] });

    const coachPlayer = await createPlayer(db, { displayName: "Coach", locale: "en", email: secret.coachEmail, phone: secret.coachPhone });
    const coach = await createCoach(db, { playerId: coachPlayer.id, displayName: "Coach", clubNames: "Leak Padel Club", tz: "Asia/Bangkok", hours: presetHours("both") });
    await db.update(coaches).set({ promptpayId: secret.promptpay, payLink: secret.payLink, inviteCode: secret.coachInvite }).where(eq(coaches.id, coach.id));
    const [coachRow] = await db.select().from(coaches).where(eq(coaches.id, coach.id));

    const club = await claimClub(db, { name: "Leak Padel Club", playerId: org.id, tz: "Asia/Bangkok", website: "https://leak.example", bookingUrl: "https://playtomic.io/leak" });
    secret.manageToken = club.manageToken;
    await decideClub(db, club.slug, true, NOW);

    // A finished tournament becomes a series; its rows copy the event's fields, the payment note among them.
    const open = await createEvent(db, { creatorPlayerId: org.id, type: "tournament", capacity: 8, startsAt: new Date(NOW.getTime() - 90 * 60 * 1000), tz: "Asia/Bangkok", venueName: "Leak Padel Club", whenFull: "waitlist", cost: "500 THB", payNote: secret.payNote });
    await db.update(events).set({ status: "past", standings: [] }).where(eq(events.id, open.id));
    const { series, next } = await createSeriesFromEvent(db, { eventId: open.id, organizerPlayerId: org.id, name: "Leak Open", every: "week", now: NOW });

    const board = await getVenueBoard(db, venueSlug("Leak Padel Club")!, NOW);
    expect(board).not.toBeNull();

    const shapes: Record<string, unknown> = {
      match: matchToPublic(detail!, BASE),
      board: boardToPublic(board!, BASE),
      group: groupToPublic(await getGroupDetail(db, group, NOW), BASE),
      coach: coachToPublic(coachRow, BASE, { city: "phuket", slots: [new Date(NOW.getTime() + DAY)] }),
      club: clubToPublic((await getClub(db, club.slug))!, BASE),
      series: seriesToPublic(series, next, BASE, "Org"),
      seriesPage: seriesPageToPublic(await seriesPage(db, series, NOW), BASE),
    };
    for (const [shape, value] of Object.entries(shapes)) {
      const text = JSON.stringify(value);
      const leaked = Object.entries(secret).filter(([, v]) => text.includes(v)).map(([k]) => `${shape} carries ${k}`);
      expect(leaked).toEqual([]);
    }
  });
});
