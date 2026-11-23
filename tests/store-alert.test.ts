import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { alertOnServices, refreshStoreBytes } from "@/lib/ops/alerts";
import { CEILINGS, STORE_BYTES_KEY, serviceBoard } from "@/lib/ops/services";
import { createTestDb, makePlayer } from "./helpers/db";

/**
 * The owner, 23 November 2026: "Send Erik an alert when we get close to filling up 1 TB, by email ... and
 * with the Telegram bot". The reel host weighs its store once a day, the hourly job keeps the figure, the
 * service board holds it against the 1 TiB a month that costs nothing, and a red row goes out once a month
 * on Telegram and by email to the owner's own record.
 */
const NOW = new Date("2026-11-24T03:00:00Z");
const DAY = dayKey(NOW);
const GIB = 1024 ** 3;

describe("the store of match videos and reels on the service board", () => {
  let db: Db;
  let close: () => Promise<void>;
  let telegram: string[] = [];
  const dir = mkdtempSync(path.join(os.tmpdir(), "store-alert-"));
  const sink = path.join(dir, "mail.jsonl");
  const mails = () => {
    try {
      return readFileSync(sink, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { to: string; subject: string; text: string });
    } catch {
      return [];
    }
  };
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    await makePlayer(db, "Owner", { telegramId: 777, email: "owner@example.test" });
  });
  afterAll(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "1:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    process.env.REEL_UPLOAD_URL = "https://reels.example.test";
    process.env.RESEND_API_KEY = "re_test_store";
    process.env.EMAIL_SINK_FILE = sink;
    telegram = [];
    rmSync(sink, { force: true });
    await db.delete(metricsDaily);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("api.telegram.org")) return new Response("not found", { status: 404 });
        telegram.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 777 } } }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const storeOnly = async () => {
    const board = await serviceBoard(db, NOW);
    return { ...board, rows: board.rows.filter((r) => r.key === "modal_store") };
  };
  const host = (bytes: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify({ bytes, at: 1 }), { status })) as unknown as typeof fetch;

  it("asks the reel host once a day, keeps the answer, and keeps the last figure when the host does not answer", async () => {
    const ask = host(300 * GIB);
    expect(await refreshStoreBytes(db, NOW, ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(String((ask as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0])).toBe("https://reels.example.test/usage");
    // The same day: no second question.
    expect(await refreshStoreBytes(db, NOW, ask)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(1);
    const next = new Date(NOW.getTime() + 24 * 3600 * 1000);
    expect(await refreshStoreBytes(db, next, host(null, 404))).toBe(false);
    expect(await refreshStoreBytes(db, next, host("many"))).toBe(false);
    const [row] = (await storeOnly()).rows;
    expect(row).toMatchObject({ used: 300 * GIB, limit: CEILINGS.modalStoreBytes, state: "ok" });
    expect(row.usage).toBe(`300 GiB on ${DAY}`);
    expect(Math.round(row.pct ?? 0)).toBe(29);
    delete process.env.REEL_UPLOAD_URL;
    expect(await refreshStoreBytes(db, new Date(NOW.getTime() + 48 * 3600 * 1000), ask)).toBe(false);
  });

  it("is quiet below 85% of 1 TiB, and at 85% tells the owner once a month on Telegram and by email", async () => {
    expect(CEILINGS.modalStoreBytes).toBe(1024 ** 4);
    await setMetric(db, STORE_BYTES_KEY, 800 * GIB, DAY); // 78%: yellow on the board, no message
    expect((await storeOnly()).rows[0].state).toBe("warn");
    expect(await alertOnServices(db, NOW, await storeOnly())).toBe(0);
    expect(telegram).toEqual([]);
    expect(mails()).toEqual([]);

    await db.delete(metricsDaily).where(eq(metricsDaily.key, STORE_BYTES_KEY));
    await setMetric(db, STORE_BYTES_KEY, 900 * GIB, DAY); // 88%
    expect(await alertOnServices(db, NOW, await storeOnly())).toBe(1);
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain("Modal store: 900 GiB on 2026-11-24 (88% of 1024 GiB free each month, then $0.09 a GiB)");
    expect(telegram[0]).toContain("Past 1 TiB Modal bills $0.09 a month for each GiB over it.");
    const sent = mails();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: "owner@example.test", subject: "Kicksmash: Modal store is at 88%" });
    expect(sent[0].text).toContain("Modal store: 900 GiB");
    // Once a month: the next hour says nothing more, on either channel.
    expect(await alertOnServices(db, NOW, await storeOnly())).toBe(0);
    expect(telegram).toHaveLength(1);
    expect(mails()).toHaveLength(1);
    expect((await db.select().from(metricsDaily).where(like(metricsDaily.key, "svc_alert_%"))).map((r) => r.key)).toEqual(["svc_alert_modal_store_2026-11"]);
  });

  it("says nothing was measured before the first answer, and is off with no reel host", async () => {
    expect((await storeOnly()).rows[0]).toMatchObject({ state: "info", usage: "not measured yet", used: null });
    delete process.env.REEL_UPLOAD_URL;
    expect((await storeOnly()).rows[0]).toMatchObject({ state: "off", usage: "off" });
  });
});
