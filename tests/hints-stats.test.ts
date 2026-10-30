import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import { deviceHints, type Player } from "@/db/schema";
import { GET as hintsStats } from "@/app/api/admin/hints-stats/route";
import { createPlayer } from "@/lib/domain/players";
import { canonicalSignals, cleanSignals, type SignalsWire } from "@/lib/domain/hintSignals";
import { hintKey } from "@/lib/deviceHint";
import { forgetOperators } from "@/lib/api/secret";
import { freezeClock } from "./helpers/clock";

/**
 * The counts-only report on the device keys (the owner, 30 October 2026: "check the digital footprints for
 * all current users, how many uniques and how many are indistinguishable?"). GET /api/admin/hints-stats,
 * behind the operator's token as /api/admin/sql is, answers counts in one statement and never a key, a
 * label for one player, a player id or a name. Each case below is a group the answer must count: a key
 * of one player, a pair, a trio, a player with two phones, and a player in two shared groups.
 */
const NOW = new Date(Date.UTC(2026, 9, 30, 5, 0));
freezeClock(NOW);
const SECRET = "hints-stats-operator-secret-long-enough";

const PHONE: SignalsWire = { w: 390, h: 844, dpr: 3, langs: ["en-us"], tz: "Asia/Bangkok", platform: "iphone", touch: 5, text: 17, motion: false, canvas: "Qm9vbS1jYW52", webgl: "V2ViR0wtaGFz", audio: "QXVkaW8taGFz" };
/** A real key for each set of values, as the doors make it: the answer must contain none of them. */
const keyOf = (v: SignalsWire) => hintKey(canonicalSignals(cleanSignals(v)!), "a-session-secret-for-the-report");
const KEYS = {
  ana: keyOf({ ...PHONE, w: 375, h: 667 }),
  pair: keyOf(PHONE),
  trio: keyOf({ ...PHONE, w: 393, h: 852 }),
  boIpad: keyOf({ ...PHONE, w: 820, h: 1180, platform: "ipad" }),
  ipadPair: keyOf({ ...PHONE, w: 744, h: 1133, platform: "ipad" }),
  gusIphone: keyOf({ ...PHONE, w: 430, h: 932 }),
  gusAndroid: keyOf({ ...PHONE, w: 412, h: 915, platform: "android", dpr: 2.75 }),
};

const ask = (query = "", token: string | null = SECRET) => hintsStats(new Request(`https://kicksma.sh/api/admin/hints-stats${query}`, { headers: token === null ? {} : { authorization: `Bearer ${token}` } }));

describe("the report on device keys answers counts only", () => {
  let db: Db;
  const people: Player[] = [];
  /** The token the worker had before this file, put back after it. */
  let before: string | undefined;

  beforeAll(async () => {
    db = await getDb();
    before = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
    forgetOperators();
    const hold = async (name: string, rows: [key: string, label: string][]) => {
      const p = await createPlayer(db, { displayName: name, locale: "en" });
      people.push(p);
      for (const [key, label] of rows) await db.insert(deviceHints).values({ playerId: p.id, key, label, createdAt: NOW, lastSeenAt: NOW });
    };
    // Unique: Ana alone holds her key.
    await hold("Ana Report", [[KEYS.ana, "iPhone"]]);
    // A pair: Bo and Cy, two iPhones of one model; Bo also has an iPad that nobody else has.
    await hold("Bo Report", [
      [KEYS.pair, "iPhone"],
      [KEYS.boIpad, "iPad"],
    ]);
    await hold("Cy Report", [[KEYS.pair, "iPhone"]]);
    // A trio. Ed also shares an iPad with Ivy: he is one indistinguishable player, though he holds two shared keys.
    await hold("Di Report", [[KEYS.trio, "iPhone"]]);
    await hold("Ed Report", [
      [KEYS.trio, "iPhone"],
      [KEYS.ipadPair, "iPad"],
    ]);
    await hold("Flo Report", [[KEYS.trio, "iPhone"]]);
    await hold("Ivy Report", [[KEYS.ipadPair, "iPad"]]);
    // A player with two phones, each key his alone.
    await hold("Gus Report", [
      [KEYS.gusIphone, "iPhone"],
      [KEYS.gusAndroid, "Android phone"],
    ]);
    // A player with no key is not counted anywhere.
    people.push(await createPlayer(db, { displayName: "Hal Report", locale: "en" }));
  });

  // Files share a worker (vitest.config.mts, `isolate: false`): the next file meets the token it would have met without this one.
  afterAll(() => {
    if (before === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = before;
    forgetOperators();
  });

  it("counts players, keys, distinct keys, unique and shared keys, the players who share one, and the sizes of the groups", async () => {
    const res = await ask();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      label: null,
      players: 8,
      keys: 11,
      distinctKeys: 7,
      unique: 4,
      shared: 3,
      indistinguishablePlayers: 6,
      groups: [
        { size: 1, keys: 4 },
        { size: 2, keys: 2 },
        { size: 3, keys: 1 },
      ],
    });
  });

  it("counts one label when asked: iPhone, iPad, Android phone", async () => {
    expect(await (await ask("?label=iPhone")).json()).toEqual({
      ok: true,
      label: "iPhone",
      players: 7,
      keys: 7,
      distinctKeys: 4,
      unique: 2,
      shared: 2,
      indistinguishablePlayers: 5,
      groups: [
        { size: 1, keys: 2 },
        { size: 2, keys: 1 },
        { size: 3, keys: 1 },
      ],
    });
    expect(await (await ask("?label=iPad")).json()).toMatchObject({
      label: "iPad",
      players: 3,
      keys: 3,
      distinctKeys: 2,
      unique: 1,
      shared: 1,
      indistinguishablePlayers: 2,
      groups: [
        { size: 1, keys: 1 },
        { size: 2, keys: 1 },
      ],
    });
    expect(await (await ask(`?label=${encodeURIComponent("Android phone")}`)).json()).toMatchObject({ label: "Android phone", players: 1, unique: 1, shared: 0 });
    // An empty label is no label.
    expect(await (await ask("?label=")).json()).toMatchObject({ label: null, players: 8 });
  });

  it("refuses a label it does not know, and never echoes it", async () => {
    const res = await ask(`?label=${encodeURIComponent("iPhone' or 1=1 --")}`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("1=1");
    expect(JSON.parse(body)).toMatchObject({ error: "unknown label", labels: ["iPhone", "iPad", "Android phone", "other"] });
  });

  it("contains no key, no player id and no name", async () => {
    for (const query of ["", "?label=iPhone", "?label=iPad"]) {
      const body = await (await ask(query)).text();
      for (const key of Object.values(KEYS)) expect(body, query).not.toContain(key);
      for (const p of people) {
        expect(body, query).not.toContain(p.id);
        expect(body, query).not.toContain(p.displayName);
      }
      expect(body, query).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      // A key is 43 characters of base64url; no word in the answer is near that long.
      expect(body, query).not.toMatch(/[A-Za-z0-9_-]{40,}/);
    }
  });

  it("refuses a request with no token or a wrong one, before it reads anything", async () => {
    for (const token of [null, "", "wrong-secret-of-some-length", `${SECRET}x`]) {
      const res = await ask("", token);
      expect(res.status, String(token)).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    }
  });
});
