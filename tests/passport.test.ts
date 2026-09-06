import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events } from "@/db/schema";
import { createEvent } from "@/lib/domain/events";
import { LEVEL_SCALES, fromScale } from "@/lib/domain/levels";
import { canonical, isExpired, keyId, passportKeysDocument, signPassport, verifyPassport, type Passport } from "@/lib/domain/passport";
import { buildPassport, exportPlayerData, getPublicPlayer, isValidPublicSlug, issuePassport, mintPublicSlug, profileStats, setPublicProfile } from "@/lib/domain/profile";
import { saveMatchScore } from "@/lib/domain/scores";
import { joinEvent } from "@/lib/domain/slots";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

// Test-only key pair (the same one the e2e runner uses).
const PRIV = "8e634fbeffa64d5c4fcbdaa76e1aadaa388eeaa636cd8179f0d858311c321ab7";
const PUB = "041adb0508a2d16a6e97203251a2a85ce6e30c2fa2ec6498fc1ddec242265447";

describe("level scales", () => {
  it("maps other apps' numbers onto 0–7 in quarter steps and rejects nonsense", () => {
    expect(LEVEL_SCALES.map((s) => s.id)).toEqual(["playtomic", "ten", "five"]);
    expect(fromScale("playtomic", 3.5)).toBe(3.5);
    expect(fromScale("ten", 1)).toBe(0.5);
    expect(fromScale("ten", 10)).toBe(7);
    expect(fromScale("ten", 4)).toBe(2.75);
    expect(fromScale("ten", 7)).toBe(4.75);
    expect(fromScale("five", 1)).toBe(1.25);
    expect(fromScale("five", 3)).toBe(3.25);
    expect(fromScale("five", 5)).toBe(5.5);
    expect(fromScale("ten", 11)).toBeNull();
    expect(fromScale("five", 0)).toBeNull();
    expect(fromScale("lunda", 3)).toBeNull();
    expect(fromScale("ten", "abc")).toBeNull();
    expect(fromScale("ten", "8")).toBe(5.5);
  });
});

describe("passport signing", () => {
  const doc: Passport = { v: 1, iss: "https://kicksma.sh", kid: keyId(PUB), sub: "https://kicksma.sh/u/ana-x7k2m", name: "Ana", level: 3.5, band: "intermediate", verified: true, source: "adjusted", played: 12, won: 7, issuedAt: "2026-09-06T10:00:00.000Z", expiresAt: "2026-12-05T10:00:00.000Z" };
  it("canonical JSON sorts keys at every level and drops undefined", () => {
    expect(canonical({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null }, u: undefined })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonical("x")).toBe('"x"');
  });
  it("signs with Ed25519 and verifies; any change or the wrong key fails", async () => {
    const signed = await signPassport(doc, PRIV, PUB);
    expect(signed.alg).toBe("Ed25519");
    expect(signed.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(await verifyPassport(signed, PUB)).toBe(true);
    expect(await verifyPassport({ ...signed, level: 5 }, PUB)).toBe(false);
    expect(await verifyPassport({ ...signed, sig: signed.sig.replace(/^./, signed.sig[0] === "A" ? "B" : "A") }, PUB)).toBe(false);
    expect(await verifyPassport(signed, "00".repeat(32))).toBe(false);
    expect(await verifyPassport({ ...signed, kid: "deadbeef" }, PUB)).toBe(false);
    expect(await verifyPassport({ ...signed, alg: "none" as "Ed25519" }, PUB)).toBe(false);
    // Key order in the object does not matter: the canonical form is what is signed.
    const shuffled = Object.fromEntries(Object.entries(signed).reverse()) as typeof signed;
    expect(await verifyPassport(shuffled, PUB)).toBe(true);
    expect(isExpired(doc, new Date("2026-12-06T00:00:00Z"))).toBe(true);
    expect(isExpired(doc, new Date("2026-10-01T00:00:00Z"))).toBe(false);
  });
  it("publishes the key JWKS-style with the exact signing recipe", () => {
    const d = passportKeysDocument("https://kicksma.sh", PUB);
    expect(d.keys[0]).toMatchObject({ kid: keyId(PUB), kty: "OKP", crv: "Ed25519", hex: PUB });
    expect(d.keys[0].x).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(d.format).toContain("canonical JSON");
  });
});

describe("public profile, passport and export (db)", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    process.env.PASSPORT_PRIVATE_KEY = PRIV;
    process.env.PASSPORT_PUBLIC_KEY = PUB;
  });
  afterAll(async () => {
    await close();
    delete process.env.PASSPORT_PRIVATE_KEY;
    delete process.env.PASSPORT_PUBLIC_KEY;
  });

  it("mints a slug once, switches the page on and off, keeps the slug", async () => {
    expect(mintPublicSlug("Ana María")).toMatch(/^ana-[a-z0-9]{5}$/);
    expect(mintPublicSlug("Александр")).toMatch(/^player-[a-z0-9]{5}$/);
    expect(isValidPublicSlug("ana-x7k2m")).toBe(true);
    expect(isValidPublicSlug("A")).toBe(false);
    const ana = await makePlayer(db, "Ana", { level: 3.5, levelSource: "self" });
    expect(ana.publicProfile).toBe(false);
    const on = (await setPublicProfile(db, ana.id, true))!;
    expect(on.publicProfile).toBe(true);
    expect(on.publicSlug).toMatch(/^ana-[a-z0-9]{5}$/);
    expect(on.publicSince).not.toBeNull();
    expect((await getPublicPlayer(db, on.publicSlug!))?.id).toBe(ana.id);
    const off = (await setPublicProfile(db, ana.id, false))!;
    expect(off.publicSlug).toBe(on.publicSlug);
    expect(await getPublicPlayer(db, on.publicSlug!)).toBeNull();
    const again = (await setPublicProfile(db, ana.id, true))!;
    expect(again.publicSlug).toBe(on.publicSlug);
    expect(again.publicSince?.getTime()).toBe(on.publicSince?.getTime());
    expect(await getPublicPlayer(db, "nobody-00000")).toBeNull();
  });

  it("issues a verifiable passport from the player's results and exports everything without secrets", async () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const org = await makePlayer(db, "Bo", { level: 4, levelSource: "self" });
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(Date.now() + 30 * 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist" });
    await joinEvent(db, { eventId: ev.id, playerId: org.id });
    for (const name of ["C", "D", "E"]) {
      const p = await makePlayer(db, name);
      await joinEvent(db, { eventId: ev.id, playerId: p.id });
    }
    await db.update(events).set({ startsAt: new Date(now.getTime() - 3 * HOUR) }).where(eq(events.id, ev.id));
    await saveMatchScore(db, { eventId: ev.id, sets: [{ setNumber: 1, sideA: 6, sideB: 3 }], playerId: org.id, isCreator: true, now });
    const bo = (await setPublicProfile(db, org.id, true))!;
    const stats = await profileStats(db, bo, now);
    expect(stats.played).toBe(1);
    expect(stats.clubs).toEqual([{ slug: "rawai-padel-club", name: "Rawai Padel Club" }]);

    const doc = buildPassport(bo, stats, "https://kicksma.sh", PUB, now);
    expect(doc).toMatchObject({ v: 1, iss: "https://kicksma.sh", kid: keyId(PUB), sub: `https://kicksma.sh/u/${bo.publicSlug}`, name: "Bo", level: 4, band: "advanced", verified: false, played: 1 });
    expect(new Date(doc.expiresAt).getTime() - now.getTime()).toBe(90 * 24 * HOUR);
    const signed = await issuePassport(bo, stats, "https://kicksma.sh", now);
    expect(signed.alg).toBe("Ed25519");
    expect(await verifyPassport(signed as Parameters<typeof verifyPassport>[0], PUB)).toBe(true);

    const data = await exportPlayerData(db, bo, "https://kicksma.sh", now);
    expect(data.format).toBe("kicksmash-export/1");
    expect(data.player.displayName).toBe("Bo");
    expect(data.player.publicUrl).toBe(`https://kicksma.sh/u/${bo.publicSlug}`);
    expect(data.matches.past).toHaveLength(1);
    expect(data.matches.past[0]).toMatchObject({ code: ev.code, organizer: true, seat: 1, venue: "Rawai Padel Club" });
    expect(data.passport.alg).toBe("Ed25519");
    const raw = JSON.stringify(data);
    expect(raw).not.toContain("personalToken");
    expect(raw).not.toContain("manageCode");
    expect(raw).not.toContain(ev.manageCode);

    delete process.env.PASSPORT_PRIVATE_KEY;
    const unsigned = await issuePassport(bo, stats, "https://kicksma.sh", now);
    expect(unsigned.alg).toBe("none");
    expect(unsigned.sig).toBeNull();
    process.env.PASSPORT_PRIVATE_KEY = PRIV;
  });
});
