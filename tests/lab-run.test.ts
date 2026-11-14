import { beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { labRuns } from "@/db/schema";

// The door answers, then prunes in after(); outside a request the test runs what was deferred itself.
const later = vi.hoisted(() => [] as Array<() => unknown>);
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void later.push(fn) }));
const settle = async () => { while (later.length) await later.shift()!(); };
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
    await settle();
  });
});

// The owner, 14 November 2026: "Send automatically". Each finder run sends a few still frames.
describe("the pictures the lab page sends", () => {
  const JPEG = "/9j/4AAQSkZJRgABAQAAAQABAAD" + "A".repeat(200);
  const pic = (id: string, ip = "203.0.113.8") => send({ id, page: "rally-finder 2026-11-14.7", stage: "pic", data: { run: ID, rally: 1, t: 40.2, jpeg: JPEG, bodies: [] } }, ip);
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const days = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

  it("keeps a JPEG and refuses anything else", async () => {
    expect((await pic(uuid(1))).status).toBe(200);
    const [row] = await db.select().from(labRuns).where(eq(labRuns.id, uuid(1)));
    expect(row.stage).toBe("pic");
    expect((row.data as { jpeg: string }).jpeg).toBe(JPEG);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
    expect((await send({ id: uuid(2), page: "rally-finder 1", stage: "pic", data: { jpeg: png } })).status).toBe(400);
    expect((await send({ id: uuid(2), page: "rally-finder 1", stage: "pic", data: {} })).status).toBe(400);
    expect((await send({ id: uuid(2), page: "rally-finder 1", stage: "pic", data: { jpeg: "/9j/<script>" } })).status).toBe(400);
    await settle();
  });

  it("lets a picture go after 30 days while the numbers stay, and keeps the newest 100 at most", async () => {
    await db.delete(labRuns);
    await db.insert(labRuns).values([
      { id: uuid(10), page: "rally-finder 1", stage: "pic", data: { jpeg: JPEG }, createdAt: days(31) },
      { id: uuid(11), page: "rally-finder 1", stage: "who", data: { hits: 1 }, createdAt: days(31) },
      ...Array.from({ length: 101 }, (_, i) => ({ id: uuid(100 + i), page: "rally-finder 1", stage: "pic", data: { jpeg: JPEG }, createdAt: days(1 + i / 1000) })),
    ]);
    expect((await pic(uuid(999), "203.0.113.9")).status).toBe(200);
    await settle();
    const pics = await db.select({ id: labRuns.id }).from(labRuns).where(eq(labRuns.stage, "pic"));
    expect(pics).toHaveLength(100);
    const ids = new Set(pics.map((r) => r.id));
    expect(ids.has(uuid(999))).toBe(true); // the newest stays
    expect(ids.has(uuid(10))).toBe(false); // older than 30 days
    expect(ids.has(uuid(200))).toBe(false); // the oldest of the 101 recent ones, past the newest 100
    expect(await db.select().from(labRuns).where(and(eq(labRuns.id, uuid(11)), eq(labRuns.stage, "who")))).toHaveLength(1);
  });
});
