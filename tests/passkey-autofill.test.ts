import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { deviceHints, metricsDaily, notices, passkeys, players, type Player } from "@/db/schema";
import type { SignalsWire } from "@/lib/domain/hintSignals";
import { createTranslator } from "next-intl";
import { notifyPasskeySaved } from "@/lib/notify";
import { noticeVars } from "@/lib/noticeText";
import { passkeySaveAction, passkeySaveOptionsAction, passkeySignInAction, passkeySignInOptionsAction } from "@/actions/passkeys";
import { createPlayer } from "@/lib/domain/players";
import { dayKey } from "@/lib/domain/metrics";
import { answerChallenge, isPageSeal, openPageChallenge, PAGE_PURPOSE, PAGE_TTL_MS, pageChallengeCheck, pageSignInOptions, relyingParty, sealPageChallenge } from "@/lib/passkeys/page";
import { CHALLENGE_COOKIE, spendChallenge, verifyAssertion, verifyRegistration } from "@/lib/passkeys/webauthn";
import { PLAYER_COOKIE, sealPlayerId, unsealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";
import { assertion, b64, newPhoneKey, registration, signedIn, type Jar, type PhoneKey } from "./helpers/passkeyPhone";

/**
 * Passkey autofill on the player's own name field (the owner, 28 October 2026: "Yes, own name field
 * (Recommended)"). A page rendered for a browser that knows nobody carries a challenge of its own: 32
 * random bytes and an expiry ten minutes ahead, sealed with an HMAC under the purpose "passkey-page",
 * made with no database read and no call from the browser. The phone signs it when the player picks
 * their name above the keyboard, and the sign-in action checks the seal, the purpose and the expiry,
 * spends the challenge once before anything signs in, and then does exactly what the button's sign-in
 * does. Real P-256 signatures, through the very actions a browser calls (tests/helpers/passkeyPhone.ts).
 */

const T0 = new Date("2031-05-06T10:00:00Z");

describe("the page challenge", () => {
  it("asks any phone for its own passkeys: the sealed challenge, this host, Face ID or a fingerprint, and no list", () => {
    const o = pageSignInOptions(T0);
    expect(o).not.toBeNull();
    expect(Object.keys(o!).sort()).toEqual(["challenge", "expiresAt", "rpId", "userVerification"]);
    // The end of the challenge, for the browser alone (src/lib/passkeys/autofill.ts): the seal's own expiry.
    expect(o!.expiresAt).toBe(T0.getTime() + PAGE_TTL_MS);
    expect(o!.rpId).toBe(relyingParty().rpID);
    expect(o!.userVerification).toBe("required");
    expect(openPageChallenge(o!.challenge, T0)).toMatchObject({ state: "open", challenge: o!.challenge, expiresAt: new Date(T0.getTime() + PAGE_TTL_MS) });
    // A fresh challenge for every page: 32 random bytes each time.
    expect(pageSignInOptions(T0)!.challenge).not.toBe(o!.challenge);
  });

  it("is off while PASSKEY_AUTOFILL says off, and on by default", () => {
    // Files share a worker: the switch goes back even when an expect fails half way.
    try {
      process.env.PASSKEY_AUTOFILL = "off";
      expect(pageSignInOptions(T0)).toBeNull();
      process.env.PASSKEY_AUTOFILL = " OFF ";
      expect(pageSignInOptions(T0)).toBeNull();
      process.env.PASSKEY_AUTOFILL = "on";
      expect(pageSignInOptions(T0)).not.toBeNull();
      delete process.env.PASSKEY_AUTOFILL;
      expect(pageSignInOptions(T0)).not.toBeNull();
    } finally {
      delete process.env.PASSKEY_AUTOFILL;
    }
  });

  it("opens only inside its ten minutes, and says when it ran out", () => {
    const c = sealPageChallenge(T0);
    expect(openPageChallenge(c, new Date(T0.getTime() + PAGE_TTL_MS)).state).toBe("open");
    // One millisecond past the ten minutes: a seal the server made, but too old.
    expect(openPageChallenge(c, new Date(T0.getTime() + PAGE_TTL_MS + 1))).toEqual({ state: "expired" });
    // Still the server's own seal after it ran out, so the save path knows it for what it is.
    expect(isPageSeal(c)).toBe(true);
  });

  it("opens only a challenge the server sealed for this purpose", () => {
    const c = sealPageChallenge(T0);
    const [purpose, nonce, exp, sig] = Buffer.from(c, "base64url").toString("utf8").split(".");
    expect(purpose).toBe(PAGE_PURPOSE);
    expect(Buffer.from(nonce, "base64url").length).toBe(32);
    const pack = (...parts: string[]) => Buffer.from(parts.join("."), "utf8").toString("base64url");
    // Another nonce under the old signature.
    expect(openPageChallenge(pack(purpose, b64(randomBytes(32)), exp, sig), T0).state).toBe("none");
    // A later expiry under the old signature: an old page made young again.
    expect(openPageChallenge(pack(purpose, nonce, String(Number(exp) + 3_600_000), sig), T0).state).toBe("none");
    // The signature with its first character changed (not its last: base64url's last character carries two unread bits).
    expect(openPageChallenge(pack(purpose, nonce, exp, (sig[0] === "A" ? "B" : "A") + sig.slice(1)), T0).state).toBe("none");
    // A seal the server made, for another purpose: never a page's.
    const other = sealPageChallenge(T0, "passkey-other");
    expect(openPageChallenge(other, T0).state).toBe("none");
    expect(isPageSeal(other)).toBe(false);
    // A plain challenge, as the options call makes one, and things that are not challenges at all.
    for (const v of [b64(randomBytes(32)), "", "x".repeat(5000), null, 42, { challenge: c }]) expect(openPageChallenge(v, T0).state).toBe("none");
  });

  it("lets the library take only the challenge just spent, a page's own, inside its ten minutes", async () => {
    const c = sealPageChallenge(T0);
    expect(pageChallengeCheck(c, T0)(c)).toBe(true);
    // Another page's challenge, good in itself, is not the one spent.
    expect(pageChallengeCheck(c, T0)(sealPageChallenge(T0))).toBe(false);
    // The one spent, read one millisecond past its ten minutes.
    expect(pageChallengeCheck(c, new Date(T0.getTime() + PAGE_TTL_MS + 1))(c)).toBe(false);
    // A seal of another purpose, even as the one "spent".
    const other = sealPageChallenge(T0, "passkey-other");
    expect(pageChallengeCheck(other, T0)(other)).toBe(false);
    // And the library runs it on the challenge inside the signed client data.
    const k = newPhoneKey();
    const row = { id: b64(k.id), publicKey: b64(k.cose), counter: 0, transports: [] };
    expect(await verifyAssertion(assertion(k, c, 1), pageChallengeCheck(c, T0), row)).toEqual({ newCounter: 1 });
    expect(await verifyAssertion(assertion(k, c, 2), pageChallengeCheck(c, new Date(T0.getTime() + PAGE_TTL_MS + 1)), row)).toBeNull();
    expect(await verifyAssertion(assertion(k, c, 3), pageChallengeCheck(sealPageChallenge(T0), T0), row)).toBeNull();
  });

  it("reads the challenge the phone signed out of the answer's client data, and nothing else", () => {
    const c = sealPageChallenge(T0);
    expect(answerChallenge(assertion(newPhoneKey(), c, 0))).toBe(c);
    expect(answerChallenge({ response: { clientDataJSON: "not json" } })).toBeNull();
    expect(answerChallenge({ response: { clientDataJSON: b64(Buffer.from(JSON.stringify({ challenge: 7 }))) } })).toBeNull();
    expect(answerChallenge({ response: { clientDataJSON: "A".repeat(20_000) } })).toBeNull();
    expect(answerChallenge(null)).toBeNull();
  });
});

describe("the sign-in from the name field, with real signatures", () => {
  let db: Db;
  beforeAll(async () => {
    db = await getDb();
  });
  // Every action here runs on a clock of its own (never the real day): a test may move it on.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  const count = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey()), eq(metricsDaily.key, key))))[0]?.value ?? 0);
  const rowOf = async (id: string) => (await db.select().from(passkeys).where(eq(passkeys.id, id)))[0];

  /** A player with a passkey on the phone, saved by the browser that made the record. */
  async function withPasskey(name: string): Promise<{ player: Player; key: PhoneKey }> {
    const player = await createPlayer(db, { displayName: name, locale: "en" });
    const key = newPhoneKey();
    const opts = await asAction(signedIn(player), () => passkeySaveOptionsAction());
    if (!opts.result.ok) throw new Error("no save options");
    const done = await asAction({ ...signedIn(player), [CHALLENGE_COOKIE]: opts.cookies[CHALLENGE_COOKIE] }, () => passkeySaveAction(registration(key, opts.result.ok ? opts.result.data.challenge : "")));
    if (!done.result.ok) throw new Error("not saved");
    return { player, key };
  }

  /** What the name field does: the page's own challenge, the phone's answer, the action. No options call and no cookie. */
  async function autofill(jar: Jar, key: PhoneKey, counter: number, challenge = pageSignInOptions()!.challenge) {
    const answer = assertion(key, challenge, counter);
    const done = await asAction(jar, () => passkeySignInAction(answer, { via: "autofill" }));
    return { answer, done, challenge };
  }

  it("signs a browser that knows nobody in from the page's own challenge, with a full session, and counts it beside the button's way", async () => {
    const { player, key } = await withPasskey("Tim");
    const [passkey, autofilled, refused] = [await count("signin_passkey"), await count("signin_passkey_autofill"), await count("passkey_refused")];
    const { done } = await autofill({}, key, 1);
    expect(done.result).toEqual({ ok: true, data: { name: "Tim", folded: false } });
    expect(unsealPlayerId(done.cookies[PLAYER_COOKIE])).toBe(player.id);
    expect(done.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(player.id));
    expect(await count("signin_passkey")).toBe(passkey + 1);
    expect(await count("signin_passkey_autofill")).toBe(autofilled + 1);
    expect(await count("passkey_refused")).toBe(refused);
    // The page's challenge never needed a cookie, and the answer leaves none behind.
    expect(done.cookies[CHALLENGE_COOKIE]).toBeUndefined();
  });

  it("takes the device values in the same options object: both doors keep this phone's key, and only `via` counts the autofill", async () => {
    // Two changes of 28 October 2026 each gave the action a second argument: the autofill's `via` and
    // design B's device values. One options object holds both, so neither can pass for the other.
    const PHONE: SignalsWire = { w: 390, h: 844, dpr: 3, langs: ["en-US"], tz: "Asia/Bangkok", platform: "iphone", touch: 5, text: 17, motion: false };
    const { player, key } = await withPasskey("Vic");
    const hintsOf = async () => (await db.select({ label: deviceHints.label }).from(deviceHints).where(eq(deviceHints.playerId, player.id))).map((h) => h.label);
    const [passkey, autofilled] = [await count("signin_passkey"), await count("signin_passkey_autofill")];
    const field = await asAction({}, () => passkeySignInAction(assertion(key, pageSignInOptions()!.challenge, 1), { via: "autofill", hint: PHONE }));
    expect(field.result).toEqual({ ok: true, data: { name: "Vic", folded: false } });
    expect(await hintsOf()).toEqual(["iPhone"]);
    expect([await count("signin_passkey"), await count("signin_passkey_autofill")]).toEqual([passkey + 1, autofilled + 1]);
    // The button sends the values with no `via`: the same key is seen again, and no autofill is counted.
    await db.delete(deviceHints).where(eq(deviceHints.playerId, player.id));
    const opts = await asAction({}, () => passkeySignInOptionsAction());
    if (!opts.result.ok) throw new Error("no sign-in options");
    const button = await asAction({ [CHALLENGE_COOKIE]: opts.cookies[CHALLENGE_COOKIE] }, () => passkeySignInAction(assertion(key, opts.result.ok ? opts.result.data.challenge : "", 2), { hint: PHONE }));
    expect(button.result).toEqual({ ok: true, data: { name: "Vic", folded: false } });
    expect(await hintsOf()).toEqual(["iPhone"]);
    expect([await count("signin_passkey"), await count("signin_passkey_autofill")]).toEqual([passkey + 2, autofilled + 1]);
  });

  it("signs in once for the same answer sent twice, and once for a new signature over the same page", async () => {
    const { key } = await withPasskey("Uma");
    const first = await autofill({}, key, 1);
    expect(first.done.result.ok).toBe(true);
    const again = await asAction({}, () => passkeySignInAction(first.answer, { via: "autofill" }));
    expect(again.result).toEqual({ ok: false, error: "invalid" });
    expect(again.cookies[PLAYER_COOKIE]).toBeUndefined();
    const fresh = await autofill({}, key, 2, first.challenge);
    expect(fresh.done.result).toEqual({ ok: false, error: "invalid" });
    expect(fresh.done.cookies[PLAYER_COOKIE]).toBeUndefined();
  });

  it("spends the challenge before the sign-in: a challenge spent already signs nobody in and moves no counter", async () => {
    const { player, key } = await withPasskey("Vic");
    const challenge = pageSignInOptions()!.challenge;
    const opened = openPageChallenge(challenge);
    if (opened.state !== "open") throw new Error("not open");
    expect(await spendChallenge(db, opened)).toBe(true);
    const before = await rowOf(b64(key.id));
    const { done } = await autofill({}, key, 5, challenge);
    expect(done.result).toEqual({ ok: false, error: "invalid" });
    expect(done.cookies[PLAYER_COOKIE]).toBeUndefined();
    // The passkey's counter and last use stayed where they were: nothing of the sign-in ran.
    const after = await rowOf(b64(key.id));
    expect(after.counter).toBe(before.counter);
    expect(after.lastUsedAt).toEqual(before.lastUsedAt);
    expect(player.id).toBeTruthy();
  });

  it("refuses the same answer again after midnight UTC: the spend belongs to the challenge, not to the day", async () => {
    vi.setSystemTime(new Date("2031-05-06T23:55:00Z"));
    const { key } = await withPasskey("Wes");
    const challenge = pageSignInOptions()!.challenge;
    vi.setSystemTime(new Date("2031-05-06T23:58:00Z"));
    const first = await autofill({}, key, 0, challenge);
    expect(first.done.result.ok).toBe(true);
    vi.setSystemTime(new Date("2031-05-07T00:02:00Z"));
    const replay = await asAction({}, () => passkeySignInAction(first.answer, { via: "autofill" }));
    expect(replay.result).toEqual({ ok: false, error: "invalid" });
    expect(replay.cookies[PLAYER_COOKIE]).toBeUndefined();
  });

  it("answers \"expired\" for a page older than ten minutes, spends nothing, and the options call still signs in", async () => {
    const { player, key } = await withPasskey("Xan");
    const challenge = pageSignInOptions()!.challenge;
    vi.setSystemTime(new Date(T0.getTime() + PAGE_TTL_MS + 1_000));
    const refused = await count("passkey_refused");
    const late = await autofill({}, key, 1, challenge);
    expect(late.done.result).toEqual({ ok: false, error: "expired" });
    expect(late.done.cookies[PLAYER_COOKIE]).toBeUndefined();
    expect(await count("passkey_refused")).toBe(refused);
    // The challenge was not spent: an expired seal goes no further than its expiry.
    const opened = openPageChallenge(challenge, T0);
    expect(opened.state === "open" && (await spendChallenge(db, opened))).toBe(true);
    // The client's way on: today's options call, the answer over its cookie's challenge.
    const opts = await asAction({}, () => passkeySignInOptionsAction());
    if (!opts.result.ok) throw new Error("no options");
    const answer = assertion(key, opts.result.data.challenge, 2);
    const done = await asAction({ [CHALLENGE_COOKIE]: opts.cookies[CHALLENGE_COOKIE] }, () => passkeySignInAction(answer, { via: "autofill" }));
    expect(done.result).toEqual({ ok: true, data: { name: "Xan", folded: false } });
    expect(unsealPlayerId(done.cookies[PLAYER_COOKIE])).toBe(player.id);
  });

  it("refuses a seal of another purpose, and a plain challenge with no cookie behind it", async () => {
    const { key } = await withPasskey("Yan");
    expect((await autofill({}, key, 1, sealPageChallenge(T0, "passkey-other"))).done.result).toEqual({ ok: false, error: "invalid" });
    expect((await autofill({}, key, 2, b64(randomBytes(32)))).done.result).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses a page's challenge signed for another origin, by another key, or without Face ID or a fingerprint", async () => {
    const { key } = await withPasskey("Zoe");
    for (const o of [{ origin: "https://evil.example" }, { rpID: "evil.example" }, { uv: false }]) {
      const answer = assertion(key, pageSignInOptions()!.challenge, 10, o);
      const r = await asAction({}, () => passkeySignInAction(answer, { via: "autofill" }));
      expect(r.result, JSON.stringify(o)).toEqual({ ok: false, error: "invalid" });
      expect(r.cookies[PLAYER_COOKIE]).toBeUndefined();
    }
    const forged = { ...newPhoneKey(), id: key.id };
    expect((await autofill({}, forged, 50)).done.result).toEqual({ ok: false, error: "invalid" });
  });

  it("answers \"autofill_off\" to a page's challenge while PASSKEY_AUTOFILL is off, so an open page ends its autofill, and counts no refusal", async () => {
    const { key } = await withPasskey("Ari");
    const challenge = pageSignInOptions()!.challenge;
    const refused = await count("passkey_refused");
    process.env.PASSKEY_AUTOFILL = "off";
    try {
      const off = await autofill({}, key, 1, challenge);
      expect(off.done.result).toEqual({ ok: false, error: "autofill_off" });
      expect(off.done.cookies[PLAYER_COOKIE]).toBeUndefined();
      // Also a page past its ten minutes: the switch comes first, so the browser stops rather than asks again.
      vi.setSystemTime(new Date(T0.getTime() + PAGE_TTL_MS + 1_000));
      expect((await autofill({}, key, 1, challenge)).done.result).toEqual({ ok: false, error: "autofill_off" });
      vi.setSystemTime(T0);
    } finally {
      delete process.env.PASSKEY_AUTOFILL;
    }
    expect(await count("passkey_refused")).toBe(refused);
    // The challenge was not spent: with the switch on again, the same page signs in.
    expect((await autofill({}, key, 2, challenge)).done.result.ok).toBe(true);
  });

  it("grants the hint nothing: a session by name folds nothing, and a made-up hint signs in as the button does", async () => {
    const { player, key } = await withPasskey("Bea");
    const byName = await createPlayer(db, { displayName: "Bea", locale: "en" });
    const { done } = await autofill(signedIn(byName, true), key, 1);
    expect(done.result).toEqual({ ok: true, data: { name: "Bea", folded: false } });
    expect(done.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(player.id));
    const autofilled = await count("signin_passkey_autofill");
    const odd = await asAction({}, () => passkeySignInAction(assertion(key, pageSignInOptions()!.challenge, 2), { via: "admin", fold: true } as never));
    expect(odd.result).toEqual({ ok: true, data: { name: "Bea", folded: false } });
    expect(await count("signin_passkey_autofill")).toBe(autofilled);
  });

  it("never saves a passkey over a page's challenge: the save refuses a \"passkey-page\" seal", async () => {
    const challenge = sealPageChallenge(T0);
    expect(await verifyRegistration(registration(newPhoneKey(), challenge), challenge)).toBeNull();
    // The control: the same save over a plain challenge is kept.
    const plain = b64(randomBytes(32));
    expect(await verifyRegistration(registration(newPhoneKey(), plain), plain)).not.toBeNull();
  });

  it("tells the record's own channel that a phone now signs it in, after the save, through the notice gate", async () => {
    const sent: { chat: string; text: string; markup: string }[] = [];
    process.env.TELEGRAM_BOT_TOKEN = "123:autofill";
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { chat_id?: string | number; text?: string; reply_markup?: unknown };
      if (String(url).endsWith("/sendMessage")) sent.push({ chat: String(body.chat_id), text: String(body.text ?? ""), markup: JSON.stringify(body.reply_markup ?? null) });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1, chat: { id: 1 } } }), { status: 200, headers: { "content-type": "application/json" } });
    });
    try {
      const cal = await createPlayer(db, { displayName: "Cal", locale: "en" });
      await db.update(players).set({ telegramId: 7_200_001 }).where(eq(players.id, cal.id));
      const key = newPhoneKey();
      const opts = await asAction(signedIn(cal), () => passkeySaveOptionsAction());
      if (!opts.result.ok) throw new Error("no save options");
      const done = await asAction({ ...signedIn(cal), [CHALLENGE_COOKIE]: opts.cookies[CHALLENGE_COOKIE] }, () => passkeySaveAction(registration(key, opts.result.ok ? opts.result.data.challenge : "")));
      expect(done.result).toEqual({ ok: true, data: { saved: true } });
      // The inbox keeps it under its sender, with no credential id and no link.
      const rows = await db.select().from(notices).where(eq(notices.playerId, cal.id));
      expect(rows.map((r) => [r.key, r.kind])).toEqual([["noticeItem.passkeySaved", "changes"]]);
      expect(JSON.stringify(rows[0].params)).not.toContain(b64(key.id));
      // The chat got the line, with My matches as its one button: never a personal link.
      expect(sent.map((m) => m.chat)).toEqual(["7200001"]);
      expect(sent[0].text).toBe("A phone now signs you in. Not you? Remove it on My matches.");
      expect(sent[0].markup).toContain('"url":"http://localhost:3000/me"');
      expect(sent[0].markup).not.toMatch(/\/p\//);
    } finally {
      vi.unstubAllGlobals();
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  });

  it("says \"a phone\", never \"another\" or \"one more\", in every language and both forms: the first save is the usual one", () => {
    // Review, 28 October 2026: ru said "ещё один телефон" and es "Otro teléfono", so a player who saved
    // their first passkey on their own phone heard that another phone remembered them.
    const SAYS = { en: "A phone now signs you in", ru: "Теперь вас помнит новый телефон", es: "Un teléfono ya te recuerda" } as const;
    const NEVER = { en: /another|one more/i, ru: /ещё один|другой/i, es: /otro/i } as const;
    for (const l of ["en", "ru", "es"] as const) {
      const t = createTranslator({ locale: l, messages: JSON.parse(readFileSync(path.resolve(process.cwd(), "messages", `${l}.json`), "utf8")) });
      for (const params of [{ name: "iPhone, Safari" }, { what: "unknown" }] as const) {
        const line = t("noticeItem.passkeySaved" as never, noticeVars(params, l, "") as never) as string;
        expect(line, `${l} ${JSON.stringify(params)}`).toContain(SAYS[l]);
        expect(line, `${l} ${JSON.stringify(params)}`).not.toMatch(NEVER[l]);
      }
    }
  });

  it("names the phone by its label, and mails it with no personal link and no Telegram line", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "passkey-saved-"));
    process.env.RESEND_API_KEY = "re_test_only";
    process.env.EMAIL_SINK_FILE = path.join(dir, "mail.jsonl");
    process.env.TELEGRAM_BOT_TOKEN = "123:autofill";
    try {
      const dot = await createPlayer(db, { displayName: "Dot", locale: "es" });
      await db.update(players).set({ email: "dot-passkey@example.com", emailNotifications: true, locale: "es" }).where(eq(players.id, dot.id));
      const [fresh] = await db.select().from(players).where(eq(players.id, dot.id));
      await notifyPasskeySaved(db, fresh, "iPhone, Safari");
      const mail = readFileSync(process.env.EMAIL_SINK_FILE, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { to: string; subject: string; text: string });
      expect(mail.map((m) => [m.to, m.subject])).toEqual([["dot-passkey@example.com", "Un teléfono ya te recuerda: iPhone, Safari. ¿No fuiste tú? Quítalo en Mis partidos."]]);
      expect(mail[0].text).toContain("http://localhost:3000/me");
      expect(mail[0].text).not.toMatch(/\/p\/|t\.me\//);
    } finally {
      delete process.env.RESEND_API_KEY;
      delete process.env.EMAIL_SINK_FILE;
      delete process.env.TELEGRAM_BOT_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
