import { createElement, type ReactElement } from "react";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { beforeAll, describe, expect, it } from "vitest";
import { getDb, type Db } from "@/db";
import { passkeys, type Player } from "@/db/schema";
import { joinAction } from "@/actions/slots";
import { SeatedAsk } from "@/components/SeatedAsk";
import { createEvent } from "@/lib/domain/events";
import { doorsDetail, NO_DOORS, readDoors, seatedDoors, type OwnDoors } from "@/lib/domain/seatedDoors";
import { joinEvent } from "@/lib/domain/slots";
import { asAction } from "./helpers/action";
import { freezeClock } from "./helpers/clock";
import { DAY, makePlayer } from "./helpers/db";
import { renderIn } from "./helpers/render";

/**
 * The owner's decision of 16 October 2026 (D4, DECIDING rule 34). The question: ""Sign in as Danny?" now
 * shows every sign-in door: Face ID, the email code, Telegram. Telegram can make a second Danny, and Face
 * ID opens an empty sheet for most players. Which doors should it show?" The answer: "Only Danny's doors
 * (Recommended)": "The email code if Danny has an address, Telegram if linked, Face ID if he has a
 * passkey; email first."
 *
 * The join's refusal carries three booleans for the name typed (`doorsDetail`), and the question renders
 * exactly those doors: never the deployment's whole set, never an address or an id.
 */
const NOW = new Date(Date.UTC(2026, 9, 16, 4, 0));
freezeClock(NOW);

const RUNS = { email: true, telegram: true };
type Rec = Parameters<typeof seatedDoors>[0][number];
const rec = (r: Partial<Rec> = {}): Rec => ({ email: null, recoveryEmail: null, telegramId: null, passkey: false, ...r });

/** Each line changes one thing, so the change named is the only thing that decides. */
const TABLE: [string, Rec[], { email: boolean; telegram: boolean }, OwnDoors][] = [
  ["nothing to prove it (a phone, a coach's book: \"That's me\" refuses it for another reason)", [rec()], RUNS, NO_DOORS],
  ["an address", [rec({ email: "d@example.com" })], RUNS, { email: true, telegram: false, passkey: false }],
  ["only the address kept for recovery (the restore reads it too)", [rec({ recoveryEmail: "d@example.com" })], RUNS, { email: true, telegram: false, passkey: false }],
  ["an address, on a deployment that sends no mail", [rec({ email: "d@example.com" })], { email: false, telegram: true }, NO_DOORS],
  ["a linked Telegram", [rec({ telegramId: 4242 })], RUNS, { email: false, telegram: true, passkey: false }],
  ["a linked Telegram, on a deployment with no Telegram sign-in", [rec({ telegramId: 4242 })], { email: true, telegram: false }, NO_DOORS],
  ["a passkey (no setting runs it: the phone does)", [rec({ passkey: true })], { email: false, telegram: false }, { email: false, telegram: false, passkey: true }],
  ["all three", [rec({ email: "d@example.com", telegramId: 4242, passkey: true })], RUNS, { email: true, telegram: true, passkey: true }],
  ["two seated Dannys: each brings his own, so every door shown opens one of them", [rec({ email: "d@example.com" }), rec({ telegramId: 4242 })], RUNS, { email: true, telegram: true, passkey: false }],
];

describe("the doors of a seated record, as a table", () => {
  it.each(TABLE)("%s", (_why, records, runs, expected) => {
    expect(seatedDoors(records, runs)).toEqual(expected);
  });

  it("travel as three words in the refusal and come back the same; anything else reads as no door", () => {
    for (const [, records, runs] of TABLE) {
      const d = seatedDoors(records, runs);
      expect(readDoors(doorsDetail(d))).toEqual(d);
    }
    expect(doorsDetail({ email: true, telegram: false, passkey: true })).toBe("doors:email,passkey");
    expect(readDoors(undefined)).toEqual(NO_DOORS);
    expect(readDoors("danny@example.com")).toEqual(NO_DOORS);
  });
});

describe("the join's refusal carries the seated record's own doors, and only those", () => {
  let db: Db;
  let n = 0;
  beforeAll(async () => {
    db = await getDb();
  });
  /** A match with its organiser and one seated record of a name made for this test alone. */
  const seatedWith = async (name: string, extra: Partial<Player> = {}) => {
    const org = await makePlayer(db, `Org doors ${++n}`);
    const p = await makePlayer(db, name, extra);
    const ev = await createEvent(db, { creatorPlayerId: org.id, type: "match", startsAt: new Date(NOW.getTime() + 2 * DAY), tz: "Asia/Bangkok", venueName: "Rawai Padel", whenFull: "waitlist" });
    for (const x of [org, p]) await joinEvent(db, { eventId: ev.id, playerId: x.id, now: NOW });
    return { ev, p };
  };
  const refusal = async (code: string, name: string) => (await asAction({}, () => joinAction(code, name))).result;

  it("an address: the email code, and no Telegram and no Face ID", async () => {
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.TELEGRAM_BOT_TOKEN = "123:doors";
    const { ev } = await seatedWith("Mirta Doors", { email: "mirta-doors@example.com" });
    expect(await refusal(ev.code, "mirta doors")).toEqual({ ok: false, error: "name_seated", detail: "doors:email" });
  });

  it("a linked Telegram: Telegram alone; the same record without it gets no Telegram door", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:doors";
    const { ev } = await seatedWith("Tola Doors", { telegramId: 5_150_001 });
    expect(await refusal(ev.code, "Tola Doors")).toEqual({ ok: false, error: "name_seated", detail: "doors:telegram" });
    const { ev: ev2 } = await seatedWith("Tolb Doors", { phone: "+66800000001" });
    expect(await refusal(ev2.code, "Tolb Doors")).toEqual({ ok: false, error: "name_seated", detail: "doors:" });
  });

  it("a passkey: Face ID alone", async () => {
    const { ev, p } = await seatedWith("Pia Doors");
    await db.insert(passkeys).values({ id: `cred-doors-${p.id}`, playerId: p.id, publicKey: "pk", deviceType: "multiDevice" });
    expect(await refusal(ev.code, "Pia Doors")).toEqual({ ok: false, error: "name_seated", detail: "doors:passkey" });
  });

  it("never an address or an id in the answer", async () => {
    process.env.RESEND_API_KEY = "re_test_only";
    const { ev, p } = await seatedWith("Quin Doors", { email: "quin-doors@example.com", telegramId: 5_150_002 });
    const said = JSON.stringify(await refusal(ev.code, "Quin Doors"));
    expect(said).not.toContain("quin-doors@example.com");
    expect(said).not.toContain(p.id);
    expect(said).not.toContain("5150002");
  });
});

describe("the question renders the record's own doors, the email code first", () => {
  const doors = { email: true, telegram: { botId: "123", lang: "en", authUrl: "http://localhost/api/telegram/login" } };
  // The email code's box needs the app router, as a page gives it.
  const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
  const inApp = (el: ReactElement) => renderIn("en", createElement(AppRouterContext.Provider, { value: router as never }, el));
  const ask = (own: OwnDoors, claimable: string[] = []) =>
    inApp(createElement(SeatedAsk, { code: "ABCD", typed: "Danny", namesHere: ["Danny"], claimable, ask: { name: "Danny", kind: "seated", own }, doors, onDifferent: () => undefined }));
  const shown = (html: string) => ["email", "telegram", "passkey"].filter((k) => html.includes(`data-testid="seated-door-${k}"`));

  it("an address: the email code only", () => {
    const html = ask({ email: true, telegram: false, passkey: false });
    expect(shown(html)).toEqual(["email"]);
    expect(html).toContain("Danny is in this match. Sign in as Danny?");
  });

  it("a linked Telegram: Telegram only; never a Telegram door for a record with no linked Telegram, whatever the deployment runs", () => {
    expect(shown(ask({ email: false, telegram: true, passkey: false }))).toEqual(["telegram"]);
    for (const own of [NO_DOORS, { email: true, telegram: false, passkey: true }, { email: true, telegram: false, passkey: false }, { email: false, telegram: false, passkey: true }]) expect(shown(ask(own))).not.toContain("telegram");
  });

  it("the Telegram door is one line and one button, as the email door is: no \"Telegram\" heading and no pitch for a new user", () => {
    const html = ask({ email: false, telegram: true, passkey: false });
    const door = html.slice(html.indexOf('data-testid="seated-door-telegram"'));
    expect(door).toContain("With the Telegram you linked before:");
    expect(door).toContain("Sign in with Telegram");
    expect(door).not.toContain("join matches from the bot&#x27;s cards");
    expect(door).not.toMatch(/uppercase[^>]*>Telegram</);
  });

  it("a passkey: Face ID only", () => {
    expect(shown(ask({ email: false, telegram: false, passkey: true }))).toEqual(["passkey"]);
  });

  it("all three, in the owner's order: the email code, Telegram, Face ID", () => {
    const html = ask({ email: true, telegram: true, passkey: true });
    expect(shown(html)).toEqual(["email", "telegram", "passkey"]);
    const at = (k: string) => html.indexOf(`data-testid="seated-door-${k}"`);
    expect(at("email")).toBeLessThan(at("telegram"));
    expect(at("telegram")).toBeLessThan(at("passkey"));
  });

  it("none: no door at all, only \"I'm a different Danny\"", () => {
    const html = ask(NO_DOORS);
    expect(shown(html)).toEqual([]);
    expect(html).not.toContain('data-testid="seated-doors"');
    expect(html).toContain("I&#x27;m a different Danny");
  });

  it("a record \"That's me\" signs in gets its two taps and no door", () => {
    const html = ask({ email: false, telegram: false, passkey: false }, ["Danny"]);
    expect(html).toContain('data-testid="thats-me"');
    expect(shown(html)).toEqual([]);
  });
});
