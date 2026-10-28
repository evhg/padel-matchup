import { describe, expect, it } from "vitest";
import { createAutofillPage, EXPIRY_MARGIN_MS, OPTIONS_TTL_MS, usable, type HeldOptions, type SignInAnswer } from "@/lib/passkeys/autofill";
import { CHALLENGE_TTL_MS } from "@/lib/passkeys/webauthn";
import { PAGE_TTL_MS } from "@/lib/passkeys/page";

/**
 * The browser's half of the passkey above the keyboard (the owner, 28 October 2026: "Yes, own name
 * field (Recommended)"): the page's one conditional request (src/lib/passkeys/autofill.ts), driven with a
 * fake phone and a fake server on a clock of our own. What the review of 28 October 2026 found: a page
 * older than ten minutes made the player pass Face ID for an "expired"; two taps while the options call
 * was out sent two calls and left a cookie the waiting request never matched; the kill switch left the
 * autofill on every open tab.
 */

const T0 = Date.parse("2031-05-06T10:00:00Z");
type O = { challenge: string };
const settle = () => new Promise<void>((r) => setImmediate(r));

/** The phone: one conditional request at a time, as the library keeps one ceremony; a new start aborts the last. */
function fakePhone() {
  type Req = { options: O; aborted: boolean; resolve: (a: unknown) => void; reject: (e: unknown) => void };
  const requests: Req[] = [];
  let current: Req | null = null;
  const abort = () => {
    if (!current) return;
    current.aborted = true;
    current.reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
    current = null;
  };
  return {
    requests,
    waiting: () => current,
    ceremony: {
      start: (options: O) =>
        new Promise<unknown>((resolve, reject) => {
          abort();
          current = { options, aborted: false, resolve, reject };
          requests.push(current);
        }),
      cancel: abort,
    },
    /** The player picks their name above the keyboard and passes Face ID. */
    async pick() {
      const r = current;
      if (!r) throw new Error("no request waits");
      current = null;
      r.resolve({ signed: r.options.challenge });
      await settle();
    },
  };
}

/** The server: the options call (held back on demand, to show a call that is out) and the sign-in. */
function fakeServer(clock: { now: number }) {
  const s = {
    optionsCalls: 0,
    signIns: [] as unknown[],
    answers: [] as SignInAnswer[],
    holdOptions: false,
    held: [] as (() => void)[],
  };
  const make = (): HeldOptions<O> => ({ optionsJSON: { challenge: `call-${s.optionsCalls}` }, expiresAt: clock.now + OPTIONS_TTL_MS });
  return {
    s,
    server: {
      options: () => {
        s.optionsCalls += 1;
        if (!s.holdOptions) return Promise.resolve(make());
        return new Promise<HeldOptions<O>>((resolve) => s.held.push(() => resolve(make())));
      },
      signIn: async (answer: unknown) => {
        s.signIns.push(answer);
        return s.answers.shift() ?? { ok: true as const };
      },
    },
    async release() {
      for (const r of s.held.splice(0)) r();
      await settle();
    },
  };
}

function setup() {
  const clock = { now: T0 };
  const phone = fakePhone();
  const server = fakeServer(clock);
  const page = createAutofillPage<O>(server.server, () => clock.now);
  let signedIn = 0;
  const enable = async () => {
    page.enable(phone.ceremony, () => (signedIn += 1));
    await settle();
  };
  const pageOptions = (challenge: string, at = clock.now): HeldOptions<O> => ({ optionsJSON: { challenge }, expiresAt: at + PAGE_TTL_MS });
  return { clock, phone, server, page, enable, pageOptions, signedIn: () => signedIn };
}

describe("the held options' own end", () => {
  it("hands the phone nothing within the margin of its end, nothing answered already, and nothing with no challenge", () => {
    const held = { optionsJSON: { challenge: "c" }, expiresAt: T0 + 60_000 };
    expect(usable(held, T0 + 60_000 - EXPIRY_MARGIN_MS - 1)).toBe(true);
    expect(usable(held, T0 + 60_000 - EXPIRY_MARGIN_MS)).toBe(false);
    expect(usable(held, T0, new Set(["c"]))).toBe(false);
    expect(usable({ optionsJSON: {}, expiresAt: T0 + 60_000 }, T0)).toBe(false);
    expect(usable({ optionsJSON: { challenge: "c" }, expiresAt: Number.NaN }, T0)).toBe(false);
    expect(usable(null, T0)).toBe(false);
  });

  it("counts the options call's challenge as long as the server's cookie does", () => {
    expect(OPTIONS_TTL_MS).toBe(CHALLENGE_TTL_MS);
  });
});

describe("the page's one conditional request", () => {
  it("waits over the page's own challenge at once, with no call, and a pick signs in once", async () => {
    const t = setup();
    t.page.offer(t.pageOptions("page-1"));
    await t.enable();
    expect(t.phone.requests.map((r) => r.options.challenge)).toEqual(["page-1"]);
    expect(t.server.s.optionsCalls).toBe(0);
    await t.phone.pick();
    expect(t.server.s.signIns).toEqual([{ signed: "page-1" }]);
    expect(t.signedIn()).toBe(1);
  });

  it("makes no call on a view whose challenge is stale, and the first tap makes the one options call and waits over its options", async () => {
    const t = setup();
    // A page the router kept: its challenge ends within the margin.
    t.page.offer({ optionsJSON: { challenge: "page-old" }, expiresAt: T0 + EXPIRY_MARGIN_MS - 1 });
    await t.enable();
    expect(t.phone.requests).toHaveLength(0);
    expect(t.server.s.optionsCalls).toBe(0);
    t.page.focus();
    await t.server.release();
    await settle();
    expect(t.server.s.optionsCalls).toBe(1);
    expect(t.phone.requests.map((r) => r.options.challenge)).toEqual(["call-1"]);
    await t.phone.pick();
    expect(t.server.s.signIns).toEqual([{ signed: "call-1" }]);
  });

  it("ends a waiting request whose challenge went stale at the next tap, before the player can pick over it", async () => {
    const t = setup();
    t.page.offer(t.pageOptions("page-1"));
    await t.enable();
    // A tab iOS kept in memory: the player comes back eleven minutes later and taps the name field.
    t.clock.now = T0 + PAGE_TTL_MS + 60_000;
    t.page.focus();
    await settle();
    expect(t.phone.requests[0].aborted).toBe(true);
    expect(t.server.s.optionsCalls).toBe(1);
    expect(t.phone.waiting()?.options.challenge).toBe("call-1");
    await t.phone.pick();
    expect(t.server.s.signIns).toEqual([{ signed: "call-1" }]);
  });

  it("takes a refresh's new challenge when the held one is near its end, with no call, and keeps a fresh one waiting", async () => {
    const t = setup();
    t.page.offer(t.pageOptions("page-1"));
    await t.enable();
    // A live match page refreshes every 20 seconds: a new challenge each time.
    t.clock.now = T0 + 60_000;
    t.page.offer(t.pageOptions("page-2"));
    await settle();
    expect(t.phone.requests.map((r) => r.options.challenge)).toEqual(["page-1"]);
    t.clock.now = T0 + PAGE_TTL_MS - 50_000;
    t.page.offer(t.pageOptions("page-3"));
    await settle();
    expect(t.phone.requests.map((r) => [r.options.challenge, r.aborted])).toEqual([
      ["page-1", true],
      ["page-3", false],
    ]);
    expect(t.server.s.optionsCalls).toBe(0);
  });

  it("drops a stale challenge when the page comes back into view, and makes no call until a tap", async () => {
    const t = setup();
    t.page.offer(t.pageOptions("page-1"));
    await t.enable();
    t.clock.now = T0 + PAGE_TTL_MS;
    t.page.wake();
    await settle();
    expect(t.phone.requests[0].aborted).toBe(true);
    expect(t.phone.waiting()).toBeNull();
    expect(t.server.s.optionsCalls).toBe(0);
    t.page.focus();
    await settle();
    expect(t.server.s.optionsCalls).toBe(1);
    expect(t.phone.waiting()?.options.challenge).toBe("call-1");
  });

  it("never offers a challenge answered once in this tab again, as when the back button brings the old page back", async () => {
    const t = setup();
    const first = t.pageOptions("page-1");
    t.page.offer(first);
    await t.enable();
    t.server.s.answers.push({ ok: false, error: "invalid" });
    await t.phone.pick();
    expect(t.page.phase()).toBe("no");
    // The page goes, and comes back from the router's cache with the same challenge.
    t.page.leave();
    t.page.offer(first);
    await t.enable();
    expect(t.phone.requests).toHaveLength(1);
    t.page.focus();
    await settle();
    expect(t.server.s.optionsCalls).toBe(1);
    expect(t.phone.waiting()?.options.challenge).toBe("call-1");
  });

  it("makes one options call however many taps come while it is out", async () => {
    const t = setup();
    t.server.s.holdOptions = true;
    await t.enable();
    t.page.focus();
    t.page.focus();
    t.page.focus();
    await settle();
    expect(t.server.s.optionsCalls).toBe(1);
    await t.server.release();
    await settle();
    expect(t.phone.requests.map((r) => r.options.challenge)).toEqual(["call-1"]);
    expect(t.phone.waiting()).not.toBeNull();
  });

  it("answers a page's \"expired\" with one options call, also when the player taps the field again while it is out", async () => {
    const t = setup();
    t.page.offer(t.pageOptions("page-1"));
    await t.enable();
    t.server.s.holdOptions = true;
    t.server.s.answers.push({ ok: false, error: "expired" });
    await t.phone.pick();
    expect(t.page.phase()).toBe("again");
    // The line under the field says "Tap the name field again": the player does, at once.
    t.page.focus();
    await settle();
    expect(t.server.s.optionsCalls).toBe(1);
    await t.server.release();
    await settle();
    expect(t.phone.requests.map((r) => r.options.challenge)).toEqual(["page-1", "call-1"]);
    await t.phone.pick();
    expect(t.server.s.signIns).toEqual([{ signed: "page-1" }, { signed: "call-1" }]);
    expect(t.signedIn()).toBe(1);
  });

  it("ends the autofill for the page when the kill switch answers, and neither a tap nor a refresh starts it again", async () => {
    const t = setup();
    t.page.offer(t.pageOptions("page-1"));
    await t.enable();
    t.server.s.answers.push({ ok: false, error: "autofill_off" });
    await t.phone.pick();
    expect(t.page.phase()).toBe("off");
    t.page.focus();
    t.page.offer(t.pageOptions("page-2"));
    await settle();
    expect(t.server.s.optionsCalls).toBe(0);
    expect(t.phone.requests).toHaveLength(1);
    expect(t.phone.waiting()).toBeNull();
  });

  it("lets a typed name and Join go first: a stop ends the request, and options that come back after it wait for the next tap", async () => {
    const t = setup();
    t.server.s.holdOptions = true;
    await t.enable();
    t.page.focus();
    await settle();
    t.page.stop();
    await t.server.release();
    await settle();
    expect(t.phone.requests).toHaveLength(0);
    t.page.focus();
    await settle();
    expect(t.server.s.optionsCalls).toBe(1);
    expect(t.phone.waiting()?.options.challenge).toBe("call-1");
    t.page.stop();
    expect(t.phone.requests[0].aborted).toBe(true);
  });
});
