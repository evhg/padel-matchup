import { gunzipSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { BACKUP_TABLES, dumpDatabase, runBackup } from "@/lib/backup";
import { createEvent } from "@/lib/domain/events";
import { createTestDb, makePlayer, HOUR } from "./helpers/db";

describe("nightly backup", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.BACKUP_GITHUB_REPO;
    delete process.env.BACKUP_GITHUB_TOKEN;
  });

  it("dumps every table the schema declares, rows as plain JSON", async () => {
    const p = await makePlayer(db, "Backup Bo");
    await createEvent(db, { creatorPlayerId: p.id, type: "match", startsAt: new Date(Date.now() + 30 * 24 * HOUR), tz: "Asia/Bangkok", venueName: "Rawai Padel Club", whenFull: "waitlist" });
    expect(BACKUP_TABLES).toEqual(expect.arrayContaining(["players", "events", "slots", "telegram_chats", "clubs", "metrics_daily"]));
    const dump = await dumpDatabase(db);
    expect(Object.keys(dump).sort()).toEqual([...BACKUP_TABLES]);
    expect((dump.players as { display_name: string }[]).some((r) => r.display_name === "Backup Bo")).toBe(true);
    expect((dump.events as { venue_name: string }[]).some((r) => r.venue_name === "Rawai Padel Club")).toBe(true);
  });

  it("without the repository and token it does nothing; with them it puts one gzipped file a day and prunes old ones", async () => {
    const now = new Date("2026-09-06T05:00:00Z");
    expect(await runBackup(db, now)).toEqual({ status: "skipped" });
    process.env.BACKUP_GITHUB_REPO = "evhg/kicksmash-backups";
    process.env.BACKUP_GITHUB_TOKEN = "github_pat_test";
    // Before 03:00 UTC nothing runs either.
    expect(await runBackup(db, new Date("2026-09-06T01:00:00Z"))).toEqual({ status: "skipped" });
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        calls.push({ url: String(url), method, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (method === "GET" && String(url).endsWith("/contents/backups")) return new Response(JSON.stringify([{ name: "2026-06-01.json.gz", sha: "old", path: "backups/2026-06-01.json.gz" }, { name: "2026-09-05.json.gz", sha: "recent", path: "backups/2026-09-05.json.gz" }]), { status: 200 });
        if (method === "GET") return new Response("{}", { status: 404 });
        return new Response(JSON.stringify({ content: { sha: "new" } }), { status: method === "PUT" ? 201 : 200 });
      }),
    );
    const r = await runBackup(db, now);
    expect(r.status).toBe("done");
    expect(r.path).toBe("backups/2026-09-06.json.gz");
    expect(r.pruned).toBe(1);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toBe("https://api.github.com/repos/evhg/kicksmash-backups/contents/backups/2026-09-06.json.gz");
    const auth = (vi.mocked(fetch).mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(auth.authorization).toBe("Bearer github_pat_test");
    const payload = JSON.parse(gunzipSync(Buffer.from((put.body as { content: string }).content, "base64")).toString("utf8")) as { format: string; tables: Record<string, unknown[]> };
    expect(payload.format).toBe("kicksmash-backup/1");
    expect(payload.tables.players.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual(["https://api.github.com/repos/evhg/kicksmash-backups/contents/backups/2026-06-01.json.gz"]);
    // The same day again: nothing.
    expect(await runBackup(db, now)).toEqual({ status: "already" });
    // A refused upload is reported, not thrown.
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL, init?: RequestInit) => new Response("{}", { status: (init?.method ?? "GET") === "PUT" ? 500 : 404 })));
    expect((await runBackup(db, new Date("2026-09-07T05:00:00Z"))).status).toBe("failed");
  });
});
