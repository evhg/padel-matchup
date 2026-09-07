import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db";
import { indexNowKey, pingIndexNow, submitIndexNowDaily } from "@/lib/indexnow";
import { GET as keyFile } from "@/app/indexnow/[key]/route";
import { createTestDb } from "./helpers/db";

describe("IndexNow", () => {
  let db: Db;
  let close: () => Promise<void>;
  const before = { key: process.env.INDEXNOW_KEY, base: process.env.APP_BASE_URL };
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
  });
  afterAll(async () => close());
  afterEach(() => {
    vi.unstubAllGlobals();
    if (before.key === undefined) delete process.env.INDEXNOW_KEY;
    else process.env.INDEXNOW_KEY = before.key;
    if (before.base === undefined) delete process.env.APP_BASE_URL;
    else process.env.APP_BASE_URL = before.base;
  });

  it("is off without a well-formed key, and the key file answers only for the real key", async () => {
    delete process.env.INDEXNOW_KEY;
    expect(indexNowKey()).toBeNull();
    expect(await pingIndexNow(["/phuket"])).toEqual({ status: "skipped", urls: 1 });
    process.env.INDEXNOW_KEY = "short";
    expect(indexNowKey()).toBeNull();
    process.env.INDEXNOW_KEY = "a1b2c3d4e5f6a7b8c9d0";
    expect((await keyFile(new Request("https://kicksma.sh/indexnow/nope.txt"), { params: Promise.resolve({ key: "nope.txt" }) })).status).toBe(404);
    const ok = await keyFile(new Request("https://kicksma.sh/indexnow/a1b2c3d4e5f6a7b8c9d0.txt"), { params: Promise.resolve({ key: "a1b2c3d4e5f6a7b8c9d0.txt" }) });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("a1b2c3d4e5f6a7b8c9d0");
  });

  it("posts our own URLs once each, with the key location, and never throws", async () => {
    process.env.INDEXNOW_KEY = "a1b2c3d4e5f6a7b8c9d0";
    process.env.APP_BASE_URL = "https://kicksma.sh";
    const calls: { url: string; body: { host: string; key: string; keyLocation: string; urlList: string[] } }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    const r = await pingIndexNow(["/phuket", "https://kicksma.sh/phuket", "/ru/phuket", "https://evil.example/x"], { db, fetchImpl });
    expect(r).toEqual({ status: "sent", urls: 2, httpStatus: 202 });
    expect(calls[0].url).toBe("https://api.indexnow.org/indexnow");
    expect(calls[0].body).toEqual({ host: "kicksma.sh", key: "a1b2c3d4e5f6a7b8c9d0", keyLocation: "https://kicksma.sh/indexnow/a1b2c3d4e5f6a7b8c9d0.txt", urlList: ["https://kicksma.sh/phuket", "https://kicksma.sh/ru/phuket"] });
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect((await pingIndexNow(["/phuket"], { fetchImpl: boom })).status).toBe("failed");
  });

  it("the daily sweep runs once after 04:00 UTC and sends the pages that change daily plus anything new", async () => {
    process.env.INDEXNOW_KEY = "a1b2c3d4e5f6a7b8c9d0";
    process.env.APP_BASE_URL = "https://kicksma.sh";
    const sent: string[][] = [];
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).urlList);
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await submitIndexNowDaily(db, new Date("2026-09-07T02:00:00Z"), fetchImpl)).toEqual({ status: "skipped", urls: 0 });
    const r = await submitIndexNowDaily(db, new Date("2026-09-07T05:00:00Z"), fetchImpl);
    expect(r.status).toBe("sent");
    expect(sent[0]).toEqual(expect.arrayContaining(["https://kicksma.sh/phuket", "https://kicksma.sh/ru/phuket", "https://kicksma.sh/singapore"]));
    expect(sent[0]).not.toContain("https://kicksma.sh/about");
    expect(sent[0]).not.toContain("https://kicksma.sh/");
    // Same day, second hour: nothing again.
    expect(await submitIndexNowDaily(db, new Date("2026-09-07T06:00:00Z"), fetchImpl)).toEqual({ status: "skipped", urls: 0 });
    expect(sent).toHaveLength(1);
  });
});
