import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, metricsDaily, venues } from "@/db/schema";
import { pasteBooking } from "@/lib/booking/paste";
import { dayKey } from "@/lib/domain/metrics";
import { LIMITS } from "@/lib/domain/ratelimit";
import { freezeClock } from "./helpers/clock";
import { createTestDb, DAY, makePlayer } from "./helpers/db";

/**
 * "Paste your booking", the server's side (`pasteBooking`, which `readBookingAction` calls): thirty
 * reads a day for a caller, one read of a platform's link at most and only for what the words left
 * out, the organiser's last venue when nothing names a club, and the form's address. Every fetch is a
 * stub. NOW is Sunday 11 October 2026, 13:00 in Phuket.
 */
const NOW = new Date("2026-10-11T06:00:00Z");
freezeClock(NOW);

const PAGE = '<html><head><meta property="og:title" content="Padel at Rawai Padel" /><meta property="og:description" content="Mon 19 Oct, 20:00 - 21:30" /></head></html>';

function stub(html = PAGE) {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(html, { headers: { "content-type": "text/html" } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("a pasted booking, read on the server", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    let n = 0;
    for (const [slug, name, bookingUrl] of [
      ["warehaus", "WAREHAUS.club", null],
      ["rawai-padel", "Rawai Padel", "https://playtomic.com/clubs/rawai-padel"],
    ] as const)
      await db.insert(clubs).values({ slug, name, manageToken: `tok-${slug}-${n++}-abcdefghijklmnop`, source: "directory", tz: "Asia/Bangkok", bookingUrl });
  });
  afterAll(async () => close());

  const paste = (text: string, o: Partial<Parameters<typeof pasteBooking>[1]> = {}, fetchImpl?: typeof fetch, preview = true) =>
    pasteBooking(db, { text, tz: "Asia/Bangkok", rateKey: "k-default", now: NOW, ...o }, { fetchImpl: fetchImpl ?? stub().fetchImpl, preview });

  it("reads the owner's case and gives the form's address", async () => {
    const s = stub();
    const r = await paste("Warehaus Mon 12 Oct 18:00-19:30 court 3 with Danny, Alberto https://thepadelsociety.app.link/AbCdEf12345", { rateKey: "k-owner" }, s.fetchImpl);
    expect(r).toEqual({
      ok: true,
      read: expect.objectContaining({ club: expect.objectContaining({ slug: "warehaus" }), date: "2026-10-12", time: "18:00", names: ["Danny", "Alberto"], missing: [] }),
      href: "/?src=paste&venue=WAREHAUS.club&date=2026-10-12&time=18%3A00&tz=Asia%2FBangkok&len=90&court=3&names=Danny%2CAlberto&booked=1",
      previewed: false,
    });
    // The words said everything, so the link was never opened.
    expect(s.calls).toHaveLength(0);
  });

  it("opens one platform link, once, when the words leave something out, and counts it", async () => {
    const s = stub();
    const links = ["https://example.com/elsewhere", "https://thepadelsociety.app.link/AbCdEf12345", "https://playtomic.com/clubs/x"];
    const r = await paste("my booking", { rateKey: "k-preview", links }, s.fetchImpl);
    expect(s.calls).toEqual(["https://thepadelsociety.app.link/AbCdEf12345"]);
    expect(r.ok && r.read).toMatchObject({ club: { slug: "rawai-padel" }, clubFrom: "preview", date: "2026-10-19", time: "20:00", minutes: 90 });
    // The preview filled the club, the day and the time: the organiser checks them before a match is made.
    expect(r.ok && r.previewed).toBe(true);
    // With the preview switched off (the bot's tap), the link is never opened.
    const none = stub();
    const words = await paste("my booking", { rateKey: "k-preview", links }, none.fetchImpl, false);
    expect(none.calls).toEqual([]);
    expect(words.ok && words.previewed).toBe(false);
    const fail = stub("<html></html>");
    await paste("my booking", { rateKey: "k-preview", links }, fail.fetchImpl);
    const rows = await db.select({ key: metricsDaily.key, value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), like(metricsDaily.key, "paste_preview_%")));
    expect(Object.fromEntries(rows.map((r) => [r.key, r.value]))).toEqual({ paste_preview_ok: 1, paste_preview_fail: 1 });
  });

  it("reads no link of a platform that is switched off or resting after a block, as the 15-minute reader reads none", async () => {
    const link = "https://playtomic.com/clubs/rawai-padel";
    const at = (key: string, value: number, day = dayKey(NOW)) => db.insert(metricsDaily).values({ day, key, value }).onConflictDoUpdate({ target: [metricsDaily.day, metricsDaily.key], set: { value } });
    const tries = async (rateKey: string) => {
      const s = stub();
      const r = await paste("my booking", { rateKey, links: [link] }, s.fetchImpl);
      return { calls: s.calls.length, read: r.ok ? r.read : null };
    };
    // The switch in the deployment's environment: no read, and no database read either.
    const before = process.env.SCRAPE_DISABLED;
    try {
      for (const value of ["playtomic", "all", " Playtomic , matchi"]) {
        process.env.SCRAPE_DISABLED = value;
        expect((await tries("k-off-env")).calls, value).toBe(0);
      }
      process.env.SCRAPE_DISABLED = "matchi";
      expect((await tries("k-off-env")).calls).toBe(1);
    } finally {
      if (before === undefined) delete process.env.SCRAPE_DISABLED;
      else process.env.SCRAPE_DISABLED = before;
    }
    // The owner's switch (`scrape_off_<platform>`, `scrape_off_all`), whatever its day.
    await at("scrape_off_playtomic", 1, "2026-09-01");
    const off = await tries("k-off-row");
    expect(off.calls).toBe(0);
    // The words still fill the form: the club comes from the link itself, with no read.
    expect(off.read).toMatchObject({ club: { slug: "rawai-padel" }, clubFrom: "link", date: null, time: null });
    await at("scrape_off_playtomic", 0, "2026-09-01");
    await at("scrape_off_all", 1);
    expect((await tries("k-off-row")).calls).toBe(0);
    await at("scrape_off_all", 0);
    // A rest after a block, until its end, and not a second after.
    await at("scrape_rest_until_playtomic", Math.floor(NOW.getTime() / 1000) + 3600);
    expect((await tries("k-rest")).calls).toBe(0);
    await at("scrape_rest_until_playtomic", Math.floor(NOW.getTime() / 1000) - 1);
    expect((await tries("k-rest")).calls).toBe(1);
    // A skipped read counts on its own, never as a platform that failed to answer.
    const [skipped] = await db.select({ value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, dayKey(NOW)), eq(metricsDaily.key, "paste_preview_off")));
    expect(skipped?.value).toBe(6);
  });

  it("refuses an empty paste before it counts anything", async () => {
    expect(await paste("   ", { rateKey: "k-empty" })).toEqual({ ok: false, reason: "empty" });
    const rows = await db.select().from(metricsDaily).where(like(metricsDaily.key, "rl:paste:k-empty%"));
    expect(rows).toHaveLength(0);
  });

  it("reads thirty pastes a day from one caller, then says so, and another caller still reads", async () => {
    expect(LIMITS.bookingPastesPerIpPerDay).toBe(30);
    for (let i = 0; i < 30; i++) expect((await paste("Warehaus tomorrow 18:00", { rateKey: "k-busy" })).ok).toBe(true);
    expect(await paste("Warehaus tomorrow 18:00", { rateKey: "k-busy" })).toEqual({ ok: false, reason: "limit" });
    expect((await paste("Warehaus tomorrow 18:00", { rateKey: "k-other" })).ok).toBe(true);
    // A new day is a new count.
    expect((await paste("Warehaus tomorrow 18:00", { rateKey: "k-busy", now: new Date(NOW.getTime() + DAY) })).ok).toBe(true);
  });

  it("takes the organiser's last venue when nothing names a club, and only then", async () => {
    const me = await makePlayer(db, "Cath");
    await db.insert(venues).values([
      { creatorPlayerId: me.id, name: "Rawai Padel", lastUsedAt: new Date(NOW.getTime() - 9 * DAY) },
      { creatorPlayerId: me.id, name: "WAREHAUS.club", lastUsedAt: new Date(NOW.getTime() - 2 * DAY) },
    ]);
    const r = await paste("tomorrow 18:00 with Cath and Danny", { rateKey: "k-me", playerId: me.id, selfName: "Cath" });
    expect(r.ok && r.read).toMatchObject({ club: { slug: "warehaus" }, clubFrom: "history", names: ["Danny"], missing: [] });
    const named = await paste("Rawai Padel tomorrow 18:00", { rateKey: "k-me", playerId: me.id });
    expect(named.ok && named.read).toMatchObject({ club: { slug: "rawai-padel" }, clubFrom: "text" });
    const stranger = await paste("tomorrow 18:00", { rateKey: "k-me" });
    expect(stranger.ok && stranger.read).toMatchObject({ club: null, missing: ["club"] });
  });
});
