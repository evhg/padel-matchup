import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { caller, guard } from "@/lib/api/keys";
import { pruneRateRows } from "@/lib/domain/ratelimit";
import { clientKeyFrom, ipKey } from "@/lib/ipKey";
import { createTestDb } from "./helpers/db";

/**
 * The owner, 30 September 2026 (option A): the rate limits keep no raw IP address. The key is a hash
 * of it, keyed with SESSION_SECRET, and the rate-limit rows go after two days.
 */
// A fixed clock (rule 11): the rows below are dated around it.
const NOW = new Date(Date.UTC(2026, 8, 30, 5, 0));

describe("no raw IP address in the rate limits", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("makes a short keyed hash that says nothing about the address", () => {
    const key = ipKey("203.0.113.7");
    expect(key).toMatch(/^[0-9a-f]{16}$/);
    expect(key).toBe(ipKey("203.0.113.7"));
    expect(key).not.toBe(ipKey("203.0.113.8"));
    expect(key).not.toContain("203");
    // Keyed: without the secret, hashing every IPv4 address does not find it.
    const before = process.env.SESSION_SECRET;
    try {
      process.env.SESSION_SECRET = "another-secret";
      expect(ipKey("203.0.113.7")).not.toBe(key);
    } finally {
      if (before === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = before;
    }
  });

  it("reads the first forwarded hop, as the limits always did", () => {
    expect(clientKeyFrom(new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }))).toBe(ipKey("198.51.100.4"));
    expect(clientKeyFrom(new Headers({ "x-real-ip": "198.51.100.5" }))).toBe(ipKey("198.51.100.5"));
    expect(clientKeyFrom(new Headers())).toBe(ipKey("unknown"));
  });

  it("an MCP call counts against a row whose key holds the hash, never the address", async () => {
    const req = new Request("http://localhost/api/mcp", { method: "POST", headers: { "x-forwarded-for": "203.0.113.99" } });
    await guard(db, await caller(db, req), "mcp");
    const rows = await db.select({ key: metricsDaily.key }).from(metricsDaily).where(like(metricsDaily.key, "rl:mcp:%"));
    expect(rows.map((r) => r.key)).toEqual([expect.stringMatching(new RegExp(`^rl:mcp:ip:${ipKey("203.0.113.99")}:h\\d+$`))]);
    expect(rows.some((r) => r.key.includes("203.0.113.99"))).toBe(false);
  });

  it("deletes rate-limit rows older than two days, and nothing else", async () => {
    const days = ["2026-09-26", "2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30"];
    await db.insert(metricsDaily).values([...days.map((day) => ({ day, key: "rl:t:old", value: 1 })), { day: "2026-09-26", key: "pageviews_test", value: 7 }]);
    expect(await pruneRateRows(db, NOW)).toBe(2);
    const left = await db.select({ day: metricsDaily.day, key: metricsDaily.key }).from(metricsDaily).where(like(metricsDaily.key, "%t%"));
    expect(left.filter((r) => r.key === "rl:t:old").map((r) => r.day).sort()).toEqual(["2026-09-28", "2026-09-29", "2026-09-30"]);
    expect(left.some((r) => r.key === "pageviews_test")).toBe(true);
  });
});
