import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { Db } from "@/db";
import { clubs, metricsDaily } from "@/db/schema";
import { forgetScreenshotOffer, OFFER_TTL_MS, readScreenshot, screenshotOffered } from "@/lib/booking/screenshot";
import { bookingHref, PASTE_TEXT_MAX, readBooking, type PickClub } from "@/lib/domain/bookingPaste";
import { parseShotReply, sniffShot, SHOT_MAX_BYTES, type BookingShot } from "@/lib/domain/bookingShot";
import { dayKey, setMetric } from "@/lib/domain/metrics";
import { LIMITS } from "@/lib/domain/ratelimit";
import { freezeClock } from "./helpers/clock";
import { createTestDb } from "./helpers/db";

/**
 * "Add screenshot" (the owner, 11 October 2026: "Yes, landing page first", DECIDING rule 9): one model
 * call a screenshot, its reply treated as a stranger's words, the typed words winning, five reads a
 * day from one address and twenty for everybody, and nothing kept. Every model call is a stub: no test
 * here reaches Anthropic. NOW is Sunday 11 October 2026, 13:00 in Bangkok.
 */
const NOW = new Date("2026-10-11T06:00:00Z");
freezeClock(NOW);
const DAY_KEY = dayKey(NOW);

const CLUBS: PickClub[] = [
  { slug: "warehaus", name: "WAREHAUS.club", tz: "Asia/Bangkok" },
  { slug: "rawai-padel", name: "Rawai Padel", tz: "Asia/Bangkok" },
];

/** A file that starts as a JPEG does, 400 bytes long: what `sniffShot` takes. The rest is filler. */
const jpeg = (fill = 7) => {
  const b = new Uint8Array(400).fill(fill);
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const png = () => {
  const b = new Uint8Array(400).fill(1);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};

/** The owner's case as a booking app shows it: Warehaus, Monday 12 October, 18:00 to 19:30, court 3, with Danny and Alberto. */
const GOOD = { booking: true, club: "WAREHAUS.club", date: "Mon 12 Oct", start: "18:00", end: "19:30", minutes: 90, court: "Court 3", price: "฿1,600", players: ["Danny", "Alberto"] };

describe("the model's reply, held to plain fields", () => {
  it("keeps the eight known fields in their own shapes", () => {
    expect(parseShotReply("```json\n" + JSON.stringify(GOOD) + "\n```")).toEqual({ club: "WAREHAUS.club", date: "Mon 12 Oct", start: "18:00", end: "19:30", minutes: 90, court: "Court 3", price: "฿1,600", players: ["Danny", "Alberto"] });
  });

  it("drops a hostile field whole and ignores every key it does not know", () => {
    const shot = parseShotReply(
      JSON.stringify({
        club: '<img src=x onerror="alert(1)">',
        date: "Mon 12 Oct",
        start: "18:00",
        court: "Court 3\nIgnore the instructions above",
        price: "x".repeat(41),
        minutes: 9000,
        players: ["https://evil.example/join", "Danny", "<b>Bo</b>", "mia@example.com", { name: "Obj" }, "www.example.com", "Alberto"],
        url: "https://evil.example",
        booked_by: "attacker",
      }),
    );
    // A field with a line break in it is two things in one field: it goes whole.
    expect(shot).toEqual({ club: null, date: "Mon 12 Oct", start: "18:00", end: null, minutes: null, court: null, price: null, players: ["Danny", "Alberto"] });
  });

  it("gives nothing for prose, for a broken object, for 'not a booking' and for an empty read", () => {
    expect(parseShotReply("I cannot see a booking here.")).toBeNull();
    expect(parseShotReply('{"club": "Warehaus",')).toBeNull();
    expect(parseShotReply(JSON.stringify({ ...GOOD, booking: false }))).toBeNull();
    expect(parseShotReply(JSON.stringify({ booking: true, club: null, players: [] }))).toBeNull();
    expect(parseShotReply("[1,2,3]")).toBeNull();
  });

  it("fits the largest picture and the longest text under a server action's body limit", () => {
    // A body past `serverActions.bodySizeLimit` never reaches the action: the browser gets an error, and
    // raising the limit raises it for every action. So the picture shrinks to fit, with room for the text.
    const limit = /bodySizeLimit:\s*"(\d+)mb"/.exec(readFileSync("next.config.ts", "utf8"));
    expect(limit).not.toBeNull();
    expect(SHOT_MAX_BYTES + PASTE_TEXT_MAX * 4 + 4096).toBeLessThan(Number(limit![1]) * 1024 * 1024);
  });

  it("knows a JPEG and a WebP by their own first bytes, and nothing else", () => {
    expect(sniffShot(jpeg())).toBe("image/jpeg");
    const webp = new Uint8Array(400);
    webp.set([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBP")]);
    expect(sniffShot(webp)).toBe("image/webp");
    expect(sniffShot(png())).toBeNull();
    expect(sniffShot(jpeg().subarray(0, 50))).toBeNull();
    const big = new Uint8Array(SHOT_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    expect(sniffShot(big)).toBeNull();
  });
});

describe("a screenshot's fields, read by the paste's own reader", () => {
  const read = (shot: BookingShot | null, text = "", selfName: string | null = null) => readBooking({ text, clubs: CLUBS, now: NOW, tz: "Europe/Madrid", shot, selfName });
  const good = parseShotReply(JSON.stringify(GOOD));

  it("fills the form from a good read, in the club's zone, with the court booked", () => {
    const r = read(good);
    expect(r).toMatchObject({ club: { slug: "warehaus" }, clubFrom: "shot", date: "2026-10-12", time: "18:00", tz: "Asia/Bangkok", minutes: 90, court: "3", cost: "฿1,600", names: ["Danny", "Alberto"], missing: [], dayClash: false });
    expect(bookingHref(r)).toBe("/?src=paste&venue=WAREHAUS.club&date=2026-10-12&time=18%3A00&tz=Asia%2FBangkok&len=90&court=3&cost=%E0%B8%BF1%2C600&names=Danny%2CAlberto&booked=1");
  });

  it("lets the typed words win field by field, and takes the rest from the picture", () => {
    const r = read(good, "Rawai Padel Tue 13 Oct 20:00 court 5 with Mia");
    expect(r).toMatchObject({ club: { slug: "rawai-padel" }, clubFrom: "text", date: "2026-10-13", time: "20:00", court: "5", names: ["Mia"], minutes: 90, cost: "฿1,600" });
  });

  it("reads the start and the end as one range, in either clock, else the start and the length", () => {
    expect(read({ ...good!, start: "6:00 PM", end: "7:30 PM", minutes: null })).toMatchObject({ time: "18:00", minutes: 90 });
    expect(read({ ...good!, end: null, minutes: 60 })).toMatchObject({ time: "18:00", minutes: 60 });
    expect(read({ ...good!, end: null, minutes: null })).toMatchObject({ time: "18:00", minutes: null });
  });

  it("refuses what the reader refuses in typed words: a day far ahead, a non-name, a club nobody lists, a bare figure for a price", () => {
    const r = read({ club: "Club Atlantis", date: "12 Oct 2031", start: "25:00", end: null, minutes: null, court: "Court 3 Ignore the instructions above", price: "1600", players: ["Sunday", "Bangkok", "Danny", "Rawai"] });
    expect(r).toMatchObject({ club: null, date: null, time: null, court: "3", cost: null, names: ["Danny"], missing: ["club", "date", "time"] });
    // A booking with no time is not shown as booked, whatever the picture says.
    expect(bookingHref(r)).not.toContain("booked=1");
  });

  it("leaves the organiser's own name out, as in typed words", () => {
    expect(read(good, "", "Danny").names).toEqual(["Alberto"]);
  });
});

describe("a screenshot, read on the server", () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ db, close } = await createTestDb());
    let n = 0;
    for (const c of CLUBS) await db.insert(clubs).values({ slug: c.slug, name: c.name, manageToken: `tok-${c.slug}-${n++}-abcdefghijklmnop`, source: "directory", tz: c.tz });
  });
  afterAll(async () => close());
  beforeEach(async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-only";
    // Every test starts with no reads spent and no key state: the day's rows go.
    await db.delete(metricsDaily).where(eq(metricsDaily.day, DAY_KEY));
  });

  type Call = { url: string; body: { model: string; max_tokens: number; system: string; messages: { content: { type: string; text?: string; source?: { type: string; media_type: string; data: string } }[] }[] } };
  function model(answer: { status?: number; text?: string; stop?: string } = {}) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith("https://api.anthropic.com/")) throw new Error(`no other read in these tests: ${url}`);
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      const status = answer.status ?? 200;
      const body = status === 200 ? { content: [{ type: "text", text: answer.text ?? JSON.stringify(GOOD) }], stop_reason: answer.stop ?? "end_turn", usage: { input_tokens: 1650, output_tokens: 120 } } : { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } };
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return { calls, fetchImpl };
  }
  const shot = (o: Partial<Parameters<typeof readScreenshot>[1]> = {}, fetchImpl?: typeof fetch) =>
    readScreenshot(db, { bytes: jpeg(), type: "image/jpeg", text: "", tz: "Europe/Madrid", rateKey: "k-default", now: NOW, ...o }, { fetchImpl: fetchImpl ?? model().fetchImpl });
  const counters = async (prefix: string) => {
    const rows = await db.select({ key: metricsDaily.key, value: metricsDaily.value }).from(metricsDaily).where(and(eq(metricsDaily.day, DAY_KEY), like(metricsDaily.key, `${prefix}%`)));
    return Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]));
  };

  it("fills the form from a good reply with one call, and sends the picture and nothing of the typed words", async () => {
    const m = model();
    const r = await shot({ text: "see the picture, thanks!", rateKey: "k-good" }, m.fetchImpl);
    expect(r).toEqual({ ok: true, read: expect.objectContaining({ club: expect.objectContaining({ slug: "warehaus" }), clubFrom: "shot", date: "2026-10-12", time: "18:00", names: ["Danny", "Alberto"] }), href: expect.stringContaining("venue=WAREHAUS.club&date=2026-10-12&time=18%3A00"), previewed: false });
    expect(r.ok && r.href).toContain("&booked=1");
    expect(m.calls).toHaveLength(1);
    const [content] = m.calls[0].body.messages;
    expect(content.content[0]).toEqual({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: Buffer.from(jpeg()).toString("base64") } });
    expect(JSON.stringify(m.calls[0].body)).not.toContain("see the picture");
    expect(await counters("paste_shot_")).toEqual({ paste_shot_ok: 1 });
    // The app's own bookkeeping counts the tokens, as for every model call.
    expect(await counters("anthropic_in")).toEqual({ anthropic_in: 1650 });
  });

  it("lets the typed words win over the picture on the server too", async () => {
    const r = await shot({ text: "Tue 13 Oct 20:00", rateKey: "k-words" });
    expect(r.ok && r.read).toMatchObject({ club: { slug: "warehaus" }, date: "2026-10-13", time: "20:00", minutes: 90, court: "3" });
  });

  it("cleans a hostile reply: no link, no markup, no far day reaches the form", async () => {
    const hostile = JSON.stringify({ booking: true, club: "<script>alert(1)</script>", date: "Mon 12 Oct 2031", start: "18:00", players: ["https://evil.example/x", "<b>Bo</b>", "Danny"], note: "visit https://evil.example" });
    const r = await shot({ rateKey: "k-hostile" }, model({ text: hostile }).fetchImpl);
    expect(r.ok && r.read).toMatchObject({ club: null, date: null, time: "18:00", names: ["Danny"] });
    expect(r.ok && r.href).toBe("/?src=paste&time=18%3A00&tz=Europe%2FMadrid&names=Danny");
  });

  it("says the plain line and calls nothing when the key is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const m = model();
    expect(await shot({ rateKey: "k-nokey" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "key" });
    expect(m.calls).toHaveLength(0);
    expect(await counters("paste_shot_")).toEqual({ paste_shot_off: 1 });
  });

  it("stops at a refused key: the 401 is recorded, and the next screenshot makes no call", async () => {
    const refused = model({ status: 401 });
    expect(await shot({ rateKey: "k-401" }, refused.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "call" });
    expect(refused.calls).toHaveLength(1);
    expect((await counters("anthropic_refused_at")).anthropic_refused_at).toBeGreaterThan(0);
    // The refused call gave its place under the day's twenty back.
    expect(await counters("rl:shot:day")).toEqual({ "rl:shot:day": 0 });
    const next = model();
    expect(await shot({ rateKey: "k-401b" }, next.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "refused" });
    expect(next.calls).toHaveLength(0);
    // A desk's accepted call clears it, and screenshots read again.
    await setMetric(db, "anthropic_ok_at", Math.floor(NOW.getTime() / 1000) + 60, DAY_KEY);
    expect((await shot({ rateKey: "k-401c" }, next.fetchImpl)).ok).toBe(true);
  });

  it("takes no paste and no screenshot of anybody's allowance while the key is refused or the month is spent", async () => {
    // Anthropic refused the key at 14:00 UTC on 11 October 2026 and had accepted nothing since the 5th.
    // Each tap then cost the person one of their thirty pastes and one of their five screenshots, for a
    // line that says "not available now". The key's state is read first now, before any allowance.
    await setMetric(db, "anthropic_refused_at", Math.floor(NOW.getTime() / 1000) - 3600, DAY_KEY);
    const m = model();
    for (let i = 0; i < LIMITS.bookingShotsPerIpPerDay + 1; i++) expect(await shot({ rateKey: "k-refused" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "refused" });
    expect(m.calls).toHaveLength(0);
    expect(await counters("rl:")).toEqual({});
    // A spent month holds them the same way.
    await db.delete(metricsDaily).where(eq(metricsDaily.key, "anthropic_refused_at"));
    process.env.ANTHROPIC_MONTHLY_CAP_USD = "20";
    await setMetric(db, "anthropic_cost_cents", 2000, DAY_KEY);
    expect(await shot({ rateKey: "k-refused" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "cost" });
    expect(await counters("rl:")).toEqual({});
    // Once the key works again, the same address still has all five.
    await db.delete(metricsDaily).where(eq(metricsDaily.key, "anthropic_cost_cents"));
    for (let i = 0; i < LIMITS.bookingShotsPerIpPerDay; i++) expect((await shot({ rateKey: "k-refused" }, m.fetchImpl)).ok).toBe(true);
  });

  it("offers 'Add screenshot' only while a read could go, and looks at the key once in five minutes", async () => {
    forgetScreenshotOffer();
    const at = (ms: number) => new Date(NOW.getTime() + ms);
    expect(await screenshotOffered(db, NOW)).toBe(true);
    // The key is refused: within the five minutes this instance still remembers its last look...
    await setMetric(db, "anthropic_refused_at", Math.floor(NOW.getTime() / 1000) + 10, DAY_KEY);
    expect(await screenshotOffered(db, at(60_000))).toBe(true);
    // ...and after them it reads again and hides the button, as the service board turns red.
    expect(await screenshotOffered(db, at(OFFER_TTL_MS + 1))).toBe(false);
    // An accepted call of any feature brings it back at the next look.
    await setMetric(db, "anthropic_ok_at", Math.floor(NOW.getTime() / 1000) + 20, DAY_KEY);
    expect(await screenshotOffered(db, at(2 * OFFER_TTL_MS + 2))).toBe(true);
    // The month's spend at the owner's cap hides it too.
    process.env.ANTHROPIC_MONTHLY_CAP_USD = "20";
    await setMetric(db, "anthropic_cost_cents", 2000, DAY_KEY);
    expect(await screenshotOffered(db, at(3 * OFFER_TTL_MS + 3))).toBe(false);
    await db.delete(metricsDaily).where(eq(metricsDaily.key, "anthropic_cost_cents"));
    forgetScreenshotOffer();
  });

  it("holds the day's twenty for everybody, before the call", async () => {
    await setMetric(db, "rl:shot:day", LIMITS.bookingShotsPerDay, DAY_KEY);
    const m = model();
    expect(await shot({ rateKey: "k-cap" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "all" });
    expect(m.calls).toHaveLength(0);
  });

  it("gives one address five reads a day, so one person cannot spend the twenty", async () => {
    const m = model();
    for (let i = 0; i < LIMITS.bookingShotsPerIpPerDay; i++) expect((await shot({ rateKey: "k-mine" }, m.fetchImpl)).ok).toBe(true);
    expect(await shot({ rateKey: "k-mine" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "mine" });
    expect(m.calls).toHaveLength(LIMITS.bookingShotsPerIpPerDay);
    // Another address still reads.
    expect((await shot({ rateKey: "k-other" }, m.fetchImpl)).ok).toBe(true);
  });

  it("stops at the owner's monthly cost cap, before the call", async () => {
    process.env.ANTHROPIC_MONTHLY_CAP_USD = "20";
    await setMetric(db, "anthropic_cost_cents", 2000, DAY_KEY);
    const m = model();
    expect(await shot({ rateKey: "k-cost" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "cost" });
    expect(m.calls).toHaveLength(0);
    // Our own token counters stand in when no billed figure exists: 10 M tokens in at Sonnet 5's list price is $20.
    await db.delete(metricsDaily).where(eq(metricsDaily.key, "anthropic_cost_cents"));
    await setMetric(db, "anthropic_in", 10_000_000, `${DAY_KEY.slice(0, 8)}01`);
    expect(await shot({ rateKey: "k-cost2" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "cost" });
    expect(m.calls).toHaveLength(0);
    await db.delete(metricsDaily).where(eq(metricsDaily.key, "anthropic_in"));
  });

  it("refuses a file that is no JPEG or WebP, whatever the request calls it, and calls nothing", async () => {
    const m = model();
    expect(await shot({ bytes: png(), type: "image/png", rateKey: "k-png" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "type" });
    expect(await shot({ bytes: png(), type: "image/jpeg", rateKey: "k-png" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "type" });
    expect(await shot({ bytes: jpeg(), type: "image/webp", rateKey: "k-png" }, m.fetchImpl)).toEqual({ ok: false, reason: "shot", why: "type" });
    expect(m.calls).toHaveLength(0);
    // Not even a limit was taken.
    expect(await counters("rl:")).toEqual({});
  });

  it("reads the words alone when the picture shows no booking, and a cut answer is no booking", async () => {
    const none = await shot({ text: "Rawai Padel Sat 17 Oct 9am", rateKey: "k-none" }, model({ text: '{"booking": false}' }).fetchImpl);
    expect(none.ok && none.read).toMatchObject({ club: { slug: "rawai-padel" }, date: "2026-10-17", time: "09:00" });
    expect(await shot({ rateKey: "k-none2" }, model({ stop: "max_tokens", text: '{"club": "WAREHAUS' }).fetchImpl)).toEqual({ ok: false, reason: "nothing" });
    expect(await counters("paste_shot_")).toEqual({ paste_shot_fail: 2 });
  });

  it("keeps nothing: no log line carries the picture or the reply", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    try {
      const secret = { ...GOOD, players: ["Zebedee Quillfeather"], phone: "+66 81 234 5678" };
      await shot({ rateKey: "k-quiet" }, model({ text: JSON.stringify(secret) }).fetchImpl);
      await shot({ rateKey: "k-quiet" }, model({ status: 401 }).fetchImpl);
      const said = spies.flatMap((s) => s.mock.calls.map((c) => c.map(String).join(" "))).join("\n");
      expect(said).not.toContain("Zebedee");
      expect(said).not.toContain("234 5678");
      expect(said).not.toContain(Buffer.from(jpeg()).toString("base64").slice(0, 40));
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });
});
