import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { describeError, ERROR_ALERTS, fingerprintOf, listErrors, markErrorFixed, normalizeMessage, pruneErrors, recordAndAlert, recordError, topFrame } from "@/lib/alerts";
import { createTestDb } from "./helpers/db";

describe("production error store", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("one bug is one fingerprint: ids, numbers and line numbers do not matter", () => {
    expect(normalizeMessage("event 7f3a9c2e-1d4b-4a2f-9c1e-0b2a3c4d5e6f not found after 12 ms")).toBe("event <uuid> not found after # ms");
    const a = fingerprintOf("server", "slot 12 taken", "Error: slot 12 taken\n    at joinSlot (/var/task/.next/server/app/lib/domain/slots.js:41:13)\n    at run (/var/task/.next/server/x.js:1:1)");
    const b = fingerprintOf("server", "slot 99 taken", "Error: slot 99 taken\n    at joinSlot (/var/task/.next/server/app/lib/domain/slots.js:44:9)\n    at run (/var/task/.next/server/x.js:2:2)");
    const c = fingerprintOf("server", "slot 12 gone", null);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(topFrame("Error: x\n    at f (/var/task/node_modules/pg/x.js:1:1)\n    at g (/var/task/.next/server/app/api/x/route.js:12:3)")).toBe("at g (/var/task/.next/server/app/api/x/route.js");
    expect(describeError({ message: "from the browser", stack: null })).toEqual({ message: "from the browser", stack: null });
    expect(describeError("plain")).toEqual({ message: "plain", stack: null });
  });

  it("repeats bump the count and keep the newest sample; fixes are remembered until it comes back", async () => {
    const t0 = new Date("2026-09-07T10:00:00Z");
    const first = await recordError(db, "server", new Error("relation events_x does not exist"), { path: "/api/v1/matches" }, t0);
    expect(first.count).toBe(1);
    const again = await recordError(db, "server", new Error("relation events_x does not exist"), {}, new Date(t0.getTime() + 60_000));
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(again.count).toBe(2);
    expect(again.path).toBe("/api/v1/matches");
    const client = await recordError(db, "client", { message: "Cannot read properties of undefined (reading 'map')" }, { path: "/ABCD", digest: "1234567890" }, t0);
    expect(client.message).toContain("[digest 1234567890]");

    let open = await listErrors(db);
    expect(open.map((e) => e.fingerprint)).toEqual(expect.arrayContaining([first.fingerprint, client.fingerprint]));
    expect(open.every((e) => e.open)).toBe(true);

    const fixed = await markErrorFixed(db, first.fingerprint, "renamed the column in #99", new Date(t0.getTime() + 3600_000));
    expect(fixed?.fixNote).toBe("renamed the column in #99");
    open = await listErrors(db);
    expect(open.map((e) => e.fingerprint)).not.toContain(first.fingerprint);
    expect((await listErrors(db, { includeFixed: true })).map((e) => e.fingerprint)).toContain(first.fingerprint);

    // It comes back after the fix: open again, the note still there for context.
    const back = await recordError(db, "server", new Error("relation events_x does not exist"), {}, new Date(t0.getTime() + 7200_000));
    expect(back.count).toBe(3);
    const reopened = (await listErrors(db)).find((e) => e.fingerprint === first.fingerprint);
    expect(reopened?.open).toBe(true);
    expect(reopened?.fixNote).toBe("renamed the column in #99");
    expect(await markErrorFixed(db, "0000000000000000", null)).toBeNull();
  });

  it("an error the store has never seen is one line to the owner at once; repeats, client errors and a storm stay quiet", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    const tg: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      tg.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "content-type": "application/json" } });
    });
    try {
      const t = new Date("2026-09-11T02:00:00Z");
      const first = await recordAndAlert(db, "cron", new Error("Tavily timed out"), { path: "/api/cron/hourly" }, t);
      expect(first.count).toBe(1);
      expect(tg).toHaveLength(1);
      expect(tg[0].chat_id).toBe(777);
      expect(String(tg[0].text)).toContain("New production error (cron): Tavily timed out on /api/cron/hourly");
      expect(String(tg[0].text)).toContain("fix errors");
      const again = await recordAndAlert(db, "cron", new Error("Tavily timed out"), {}, new Date(t.getTime() + 1000));
      expect(again.count).toBe(2);
      expect(tg).toHaveLength(1);
      await recordAndAlert(db, "client", new Error("ResizeObserver loop limit exceeded"), {}, new Date(t.getTime() + 1500));
      expect(tg).toHaveLength(1);
      for (const [i, w] of ["alpha", "beta", "gamma", "delta", "epsilon"].entries()) await recordAndAlert(db, "server", new Error(`storm ${w} failed`), {}, new Date(t.getTime() + 2000 + i));
      expect(tg.length).toBeLessThanOrEqual(ERROR_ALERTS.perHour);
      expect(tg.length).toBeGreaterThan(1);
      // Marked fixed, then back: one more line, saying so; a repeat after that stays quiet.
      const later = new Date(t.getTime() + 2 * 60 * 60_000);
      await markErrorFixed(db, first.fingerprint, "PR 99", new Date(t.getTime() + 60 * 60_000));
      const n = tg.length;
      await recordAndAlert(db, "cron", new Error("Tavily timed out"), {}, later);
      expect(tg).toHaveLength(n + 1);
      expect(String(tg.at(-1)!.text)).toContain("came back after the fix");
      await recordAndAlert(db, "cron", new Error("Tavily timed out"), {}, new Date(later.getTime() + 1000));
      expect(tg).toHaveLength(n + 1);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.TELEGRAM_OWNER_ID;
    }
  });

  it("rows unseen for 90 days are pruned", async () => {
    const old = await recordError(db, "cron", new Error("ancient"), {}, new Date("2026-01-01T00:00:00Z"));
    const gone = await pruneErrors(db, new Date("2026-09-07T10:00:00Z"));
    expect(gone).toBeGreaterThanOrEqual(1);
    expect((await listErrors(db, { includeFixed: true })).map((e) => e.fingerprint)).not.toContain(old.fingerprint);
  });
});
