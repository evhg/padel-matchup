import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { like } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { AI_FEATURES, KEY_REFUSED_LINE } from "@/lib/ops/anthropic";
import { alertOnServices } from "@/lib/ops/alerts";
import { serviceBoard } from "@/lib/ops/services";
import { createTestDb } from "./helpers/db";

/**
 * The owner's one Telegram line when a service row turns red. On 11 October 2026 the line for a refused
 * Anthropic key went out as "(2% of $20 / month, your cap)" and "At the cap the feedback replies and
 * drafts stop until the month turns. Raising the cap is your call in the console.": the spending cap's
 * words, while $0.49 of $20 was spent and the key itself was the trouble. No test covered the alert.
 */
const NOW = new Date("2026-10-11T14:00:00Z");
const DAY = dayKey(NOW);
const at = Math.floor(NOW.getTime() / 1000);

describe("the owner's alert for a red service row", () => {
  let db: Db;
  let close: () => Promise<void>;
  let sent: string[] = [];
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  beforeEach(async () => {
    process.env.TELEGRAM_BOT_TOKEN = "1:test";
    process.env.TELEGRAM_OWNER_ID = "777";
    process.env.ANTHROPIC_MONTHLY_CAP_USD = "20";
    sent = [];
    await db.delete(metricsDaily);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes("api.telegram.org")) return new Response("not found", { status: 404 });
        sent.push(String((JSON.parse(String(init?.body)) as { text: string }).text));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 777 } } }), { status: 200 });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Only the Anthropic row: the other rows of an empty test database are red for their own reasons. */
  const anthropicOnly = async (now = NOW) => {
    const board = await serviceBoard(db, now);
    return { ...board, rows: board.rows.filter((r) => r.key === "anthropic") };
  };
  const alerted = async () => (await db.select().from(metricsDaily).where(like(metricsDaily.key, "svc_alert_%"))).map((r) => r.key).sort();

  it("says a refused key in its own words: no spending cap, no percentage, and every feature that stops", async () => {
    // As production on 11 October 2026: 154k tokens in and 18k out this month, the key refused at 14:00 UTC.
    await setMetric(db, "anthropic_in", 154_000, DAY);
    await setMetric(db, "anthropic_out", 18_000, DAY);
    await setMetric(db, "anthropic_refused_at", at, DAY);
    expect(await alertOnServices(db, NOW, await anthropicOnly())).toBe(1);
    expect(sent).toHaveLength(1);
    const [line] = sent;
    expect(line).toContain(`Anthropic API: ${KEY_REFUSED_LINE}.`);
    expect(line).not.toContain("At the cap");
    expect(line).not.toContain("% of");
    expect(line).not.toContain("your cap");
    expect(line).toContain("Every AI feature is off until a new ANTHROPIC_API_KEY is in Vercel and the app is deployed again");
    for (const f of AI_FEATURES) expect(line, f).toContain(f);
    expect(await alerted()).toEqual(["svc_alert_anthropic_key_2026-10"]);
    // Once a month: the next hour says nothing more.
    expect(await alertOnServices(db, NOW, await anthropicOnly())).toBe(0);
  });

  it("says the spending cap when the spend is at the cap and the key works, as its own alert of the month", async () => {
    await setMetric(db, "anthropic_refused_at", at - 7200, DAY);
    await setMetric(db, "svc_alert_anthropic_key_2026-10", 1, DAY);
    // A working key, and $18 of $20 spent: 90%.
    await setMetric(db, "anthropic_ok_at", at - 3600, DAY);
    await setMetric(db, "anthropic_cost_cents", 1800, DAY);
    expect(await alertOnServices(db, NOW, await anthropicOnly())).toBe(1);
    expect(sent[0]).toContain("(90% of $20 / month, your cap)");
    expect(sent[0]).toContain("At the cap the feedback replies and drafts stop until the month turns.");
    expect(sent[0]).not.toContain(KEY_REFUSED_LINE);
    expect(await alerted()).toEqual(["svc_alert_anthropic_2026-10", "svc_alert_anthropic_key_2026-10"]);
  });
});

describe("the service board's Anthropic row", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());

  it("names every feature the key serves, all seven", async () => {
    const row = (await serviceBoard(db, NOW)).rows.find((r) => r.key === "anthropic")!;
    for (const f of ["listening drafts", "Discord answers", "answer pages", "feedback replies", "owner proposals", "press desk drafts", "booking screenshots"]) expect(row.role, f).toContain(f);
  });
});
