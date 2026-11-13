import { beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "@/db";
import { labRuns } from "@/db/schema";

// The door answers, then prunes in after(); outside a request there is nothing to defer to.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: () => undefined }));
const { POST } = await import("@/app/api/lab/run/route");

let db: Db;
beforeAll(async () => {
  db = await (await import("@/db")).getDb();
});

const send = (body: unknown, ip = "203.0.113.7") =>
  POST(new Request("https://kicksma.sh/api/lab/run", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", "x-forwarded-for": ip } }));

const ID = "11111111-2222-4333-8444-555555555555";

describe("the Rally Finder lab page reports a run by itself", () => {
  it("keeps a run as one row, which each later stage replaces", async () => {
    expect((await send({ id: ID, page: "rally-finder 2026-11-13.2", stage: "read", data: { hits: 1491 } })).status).toBe(200);
    expect((await send({ id: ID, page: "rally-finder 2026-11-13.2", stage: "who", data: { hits: 1491, who: { bodiesPerFrame: 3.6 } } })).status).toBe(200);
    const rows = await db.select().from(labRuns).where(eq(labRuns.id, ID));
    expect(rows).toHaveLength(1);
    expect(rows[0].stage).toBe("who");
    expect(rows[0].data).toEqual({ hits: 1491, who: { bodiesPerFrame: 3.6 } });
  });

  it("refuses what is not a report from the page", async () => {
    expect((await send("not json")).status).toBe(400);
    expect((await send({ id: "x", page: "rally-finder 1", stage: "read", data: {} })).status).toBe(400);
    expect((await send({ id: ID, page: "something else", stage: "read", data: {} })).status).toBe(400);
    expect((await send({ id: ID, page: "rally-finder 1", stage: "upload", data: {} })).status).toBe(400);
    expect((await send({ id: ID, page: "rally-finder 1", stage: "read", data: [1, 2] })).status).toBe(400);
    expect((await send({ id: ID, page: "rally-finder 1", stage: "read", data: { big: "x".repeat(1_000_001) } })).status).toBe(413);
  });
});
