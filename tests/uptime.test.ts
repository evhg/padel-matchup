import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { relayUptimeIssues } from "@/lib/uptime";
import { createTestDb } from "./helpers/db";

describe("uptime relay", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    process.env.TELEGRAM_BOT_TOKEN = "123:test";
    process.env.TELEGRAM_OWNER_ID = "777";
  });
  afterAll(async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_OWNER_ID;
    await close();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tells the owner once per issue state, skips issues the workflow already relayed", async () => {
    const dms: { chat_id: number; text: string }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("api.telegram.org")) {
        dms.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([]), { headers: { "Content-Type": "application/json" } });
    });
    const issues = [
      { number: 5, state: "open", html_url: "https://github.com/evhg/padel-matchup/issues/5", created_at: "2026-09-07T03:10:00Z", closed_at: null, labels: [{ name: "uptime" }] },
      { number: 4, state: "closed", html_url: "https://github.com/evhg/padel-matchup/issues/4", created_at: "2026-09-06T01:00:00Z", closed_at: "2026-09-06T01:12:00Z", labels: [{ name: "uptime" }, { name: "notified" }] },
    ];
    const gh = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("api.telegram.org")) return fetch(url, init);
      return new Response(JSON.stringify(issues), { headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const now = new Date("2026-09-07T04:00:00Z");
    expect(await relayUptimeIssues(db, now, gh)).toEqual({ relayed: 1 });
    expect(dms).toHaveLength(1);
    expect(dms[0].chat_id).toBe(777);
    expect(dms[0].text).toContain("has not been answering since 2026-09-07 03:10");
    // Next hour, still open: silence. Then it closes: one more line with the duration.
    expect(await relayUptimeIssues(db, new Date(now.getTime() + 3600_000), gh)).toEqual({ relayed: 0 });
    issues[0] = { ...issues[0], state: "closed", closed_at: "2026-09-07T04:25:00Z" };
    expect(await relayUptimeIssues(db, new Date(now.getTime() + 7200_000), gh)).toEqual({ relayed: 1 });
    expect(dms[1].text).toContain("(75 min)");
    expect(dms[1].text).toContain("is back");
  });

  it("stays quiet when GitHub does not answer or nothing is configured", async () => {
    const down = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await relayUptimeIssues(db, new Date(), down)).toEqual({ relayed: 0 });
    const token = process.env.TELEGRAM_OWNER_ID;
    delete process.env.TELEGRAM_OWNER_ID;
    expect(await relayUptimeIssues(db, new Date())).toEqual({ relayed: 0 });
    process.env.TELEGRAM_OWNER_ID = token;
  });
});
