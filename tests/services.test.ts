import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { estimateCostUsd, fetchCostReport } from "@/lib/ops/anthropic";
import { boardHighlights, serviceBoard, stateForPct } from "@/lib/ops/services";
import { createTestDb } from "./helpers/db";

let db: Db;
let close: () => Promise<void>;
beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("the service board", () => {
  it("prices tokens at list rates and turns percentages into states", () => {
    expect(estimateCostUsd(1_000_000, 0, "claude-sonnet-5")).toBe(2);
    expect(estimateCostUsd(0, 1_000_000, "claude-haiku-4-5")).toBe(5);
    expect(estimateCostUsd(500_000, 100_000, "unknown-model")).toBeCloseTo(1 + 1, 5);
    expect(stateForPct(null)).toBe("info");
    expect(stateForPct(10)).toBe("ok");
    expect(stateForPct(60)).toBe("warn");
    expect(stateForPct(85)).toBe("alert");
  });

  it("reads the cost report only with an admin key, summing cents across pages", async () => {
    const prev = process.env.ANTHROPIC_ADMIN_KEY;
    delete process.env.ANTHROPIC_ADMIN_KEY;
    expect(await fetchCostReport(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-08T00:00:00Z"))).toBeNull();
    process.env.ANTHROPIC_ADMIN_KEY = "sk-ant-admin-test";
    const pages = [
      { data: [{ results: [{ amount: "123.5", currency: "USD" }, { amount: "76.5", currency: "USD" }] }], has_more: true, next_page: "p2" },
      { data: [{ results: [{ amount: "100", currency: "USD" }] }], has_more: false },
    ];
    let calls = 0;
    const fake: typeof fetch = async (input) => {
      const url = String(input);
      const page = pages[calls++];
      if (calls === 2) expect(url).toContain("page=p2");
      return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
    };
    const report = await fetchCostReport(new Date("2026-09-01T00:00:00Z"), new Date("2026-09-08T00:00:00Z"), fake);
    expect(report?.usd).toBe(3);
    if (prev === undefined) delete process.env.ANTHROPIC_ADMIN_KEY;
    else process.env.ANTHROPIC_ADMIN_KEY = prev;
  });

  it("builds one row per service with usage against the ceiling", async () => {
    const now = new Date("2026-09-08T12:00:00Z");
    const today = dayKey(now);
    await setMetric(db, "pageviews", 1600, today);
    await setMetric(db, "pageviews", 400, "2026-09-02");
    await setMetric(db, "pageviews", 999, "2026-08-31"); // last month: not counted
    await setMetric(db, "emails_sent", 30, today);
    await setMetric(db, "anthropic_in", 2_000_000, "2026-09-03");
    await setMetric(db, "anthropic_out", 200_000, "2026-09-03");
    await setMetric(db, "db_bytes", 120 * 1024 * 1024, today);
    await setMetric(db, "cron_hourly_at", Math.floor(now.getTime() / 1000) - 600, today);
    await setMetric(db, "cron_push_at", Math.floor(now.getTime() / 1000) - 120, today);
    await setMetric(db, "backup_done", 1, "2026-09-07");
    await setMetric(db, "domain_expires_at", Math.floor(new Date("2027-09-03T07:11:06Z").getTime() / 1000), today);
    await setMetric(db, "uptime_issue_12_open", 1, "2026-09-06");
    await setMetric(db, "uptime_issue_12_closed", 1, "2026-09-06");
    await setMetric(db, "uptime_issue_13_open", 1, today);
    const board = await serviceBoard(db, now);
    const row = (k: string) => board.rows.find((r) => r.key === k)!;
    expect(board.month).toBe("2026-09");
    expect(row("vercel_analytics").used).toBe(2000);
    expect(row("vercel_analytics").pct).toBe(80);
    expect(row("vercel_analytics").state).toBe("warn");
    expect(row("supabase_db").pct).toBe(24);
    expect(row("pg_cron").state).toBe("ok");
    // 2M in at $2 + 200k out at $10 = $6 of a $20 cap.
    expect(row("anthropic").used).toBe(6);
    expect(row("anthropic").pct).toBe(30);
    expect(row("anthropic").usage).toContain("estimated");
    expect(row("backup").state).toBe("ok");
    expect(row("uptime").state).toBe("alert");
    expect(row("uptime").usage).toBe("1 open incident");
    expect(row("domain").state).toBe("ok");
    expect(row("domain").usage).toMatch(/renews in 3\d\d days/);
    const keys = board.rows.map((r) => r.key);
    for (const k of ["vercel", "vercel_analytics", "supabase_db", "supabase_egress", "pg_cron", "resend_month", "resend_day", "telegram", "discord", "web_push", "anthropic", "tavily", "google", "indexnow", "backup", "uptime", "domain", "feedback", "api", "errors"]) expect(keys).toContain(k);
    const hot = boardHighlights(board).map((r) => r.key);
    expect(hot).toContain("vercel_analytics");
    expect(hot).toContain("uptime");
    expect(hot).not.toContain("supabase_db");
  });
});
