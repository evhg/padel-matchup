import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getDb, type Db } from "@/db";
import { metricsDaily, passkeys, players, type Player } from "@/db/schema";
import { passkeySaveAction, passkeySaveOptionsAction, passkeySignInAction, passkeySignInOptionsAction, removePasskeyAction } from "@/actions/passkeys";
import { createPlayer } from "@/lib/domain/players";
import { dayKey } from "@/lib/domain/metrics";
import { CHALLENGE_COOKIE, CHALLENGE_TTL_MS, openChallenge, passkeyUserId, relyingParty, sealChallenge } from "@/lib/passkeys/webauthn";
import { passkeyHandle, PLAYER_COOKIE, sealPlayerId, unsealPlayerId } from "@/lib/session";
import { asAction } from "./helpers/action";

/**
 * The passkey ceremony with real cryptography, through the very actions a browser calls (DECIDING rule
 * 39). The test is the phone: it makes a P-256 key pair with node:crypto, builds the attestation and the
 * assertion a platform authenticator builds (authenticator data, client data with the challenge, the
 * origin and the type, the signature), and hands them to the actions, which check them with
 * @simplewebauthn/server. Then everything that must fail fails: another origin, a challenge used twice,
 * a challenge made for another purpose or another player, a session by name, an unknown passkey.
 */

// ------------------------------------------------------------------ the phone

/** CBOR, the little of it WebAuthn needs: whole numbers, text, bytes and maps (a Map keeps number keys). */
function cbor(v: unknown): Buffer {
  const head = (major: number, n: number) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v, "utf8");
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error(`cbor: ${typeof v}`);
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
const b64 = (b: Buffer) => b.toString("base64url");
const counterBytes = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** Authenticator data flags: user present, user verified, backup eligible, backed up, attested credential data. */
const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

type PhoneKey = { privateKey: KeyObject; id: Buffer; cose: Buffer };

/** A new passkey, as a phone makes one: a P-256 key pair and a random credential id. */
function newPhoneKey(): PhoneKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  // The COSE key: kty EC2 (2), alg ES256 (-7), crv P-256 (1), x, y.
  const cose = cbor(
    new Map<number, unknown>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, Buffer.from(jwk.x!, "base64url")],
      [-3, Buffer.from(jwk.y!, "base64url")],
    ]),
  );
  return { privateKey, id: randomBytes(16), cose };
}

/** `authId`: the credential id written inside the authenticator data, when a crafted answer names another one there than its own `id`. */
type Ceremony = { origin?: string; rpID?: string; uv?: boolean; type?: string; authId?: Buffer };

/** What `navigator.credentials.create` returns for this key: attestation "none", the challenge and the origin in the client data. */
function registration(k: PhoneKey, challenge: string, o: Ceremony = {}) {
  const rp = relyingParty();
  const flags = UP | (o.uv === false ? 0 : UV) | BE | BS | AT;
  const inData = o.authId ?? k.id;
  const idLen = Buffer.alloc(2);
  idLen.writeUInt16BE(inData.length);
  const authData = Buffer.concat([sha256(o.rpID ?? rp.rpID), Buffer.from([flags]), counterBytes(0), Buffer.alloc(16), idLen, inData, k.cose]);
  const attestationObject = cbor(
    new Map<string, unknown>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authData],
    ]),
  );
  const clientDataJSON = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.create", challenge, origin: o.origin ?? rp.origin, crossOrigin: false }));
  return {
    id: b64(k.id),
    rawId: b64(k.id),
    type: "public-key",
    response: { clientDataJSON: b64(clientDataJSON), attestationObject: b64(attestationObject), transports: ["internal", "hybrid"] },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

/** What `navigator.credentials.get` returns: authenticator data, client data, and the signature over both. */
function assertion(k: PhoneKey, challenge: string, counter: number, o: Ceremony = {}) {
  const rp = relyingParty();
  const flags = UP | (o.uv === false ? 0 : UV) | BE | BS;
  const authData = Buffer.concat([sha256(o.rpID ?? rp.rpID), Buffer.from([flags]), counterBytes(counter)]);
  const clientDataJSON = Buffer.from(JSON.stringify({ type: o.type ?? "webauthn.get", challenge, origin: o.origin ?? rp.origin, crossOrigin: false }));
  const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), k.privateKey);
  return {
    id: b64(k.id),
    rawId: b64(k.id),
    type: "public-key",
    response: { authenticatorData: b64(authData), clientDataJSON: b64(clientDataJSON), signature: b64(signature) },
    clientExtensionResults: {},
    authenticatorAttachment: "platform",
  };
}

// ------------------------------------------------------------------ the browser

type Jar = Record<string, string>;
const signedIn = (p: { id: string }, byName = false): Jar => ({ [PLAYER_COOKIE]: sealPlayerId(p.id, { byName }) });

describe("the passkey ceremony, with real signatures", () => {
  let db: Db;
  beforeAll(async () => {
    db = await getDb();
  });
  const count = async (key: string) => Number((await db.select().from(metricsDaily).where(and(eq(metricsDaily.day, dayKey()), eq(metricsDaily.key, key))))[0]?.value ?? 0);
  const rowsOf = (playerId: string) => db.select().from(passkeys).where(eq(passkeys.playerId, playerId));
  const exists = async (id: string) => (await db.select().from(players).where(eq(players.id, id))).length === 1;

  /** The whole save, as the page runs it: the options, the phone, the answer. */
  async function save(jar: Jar, k = newPhoneKey(), o: Ceremony = {}) {
    const opts = await asAction(jar, () => passkeySaveOptionsAction());
    if (!opts.result.ok) return { opts, done: null, k };
    const answer = registration(k, opts.result.data.challenge, o);
    const done = await asAction({ ...jar, [CHALLENGE_COOKIE]: opts.cookies[CHALLENGE_COOKIE] }, () => passkeySaveAction(answer));
    return { opts, done, k, answer, cookie: opts.cookies[CHALLENGE_COOKIE] };
  }
  /** The whole sign-in from a browser holding `jar`. */
  async function signIn(jar: Jar, k: PhoneKey, counter: number, o: Ceremony = {}) {
    const opts = await asAction(jar, () => passkeySignInOptionsAction());
    if (!opts.result.ok) throw new Error("no options");
    const answer = assertion(k, opts.result.data.challenge, counter, o);
    const done = await asAction({ ...jar, [CHALLENGE_COOKIE]: opts.cookies[CHALLENGE_COOKIE] }, () => passkeySignInAction(answer));
    return { opts, done, answer, cookie: opts.cookies[CHALLENGE_COOKIE] };
  }

  let ana: Player;
  let anaKey: PhoneKey;

  it("asks the phone for a passkey that lives on it, Face ID or a fingerprint required, under the player's own name", async () => {
    ana = await createPlayer(db, { displayName: "Ana", locale: "en" });
    const { result, cookies } = await asAction(signedIn(ana), () => passkeySaveOptionsAction());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const o = result.data;
    expect(o.rp).toEqual({ name: "Kicksmash", id: relyingParty().rpID });
    expect(o.user.name).toBe("Ana");
    expect(o.user.displayName).toBe("Ana");
    // The handle is an HMAC of the player id, never the id: the same player, the same handle.
    expect(o.user.id).toBe(Buffer.from(passkeyUserId(ana.id)).toString("base64url"));
    expect(Buffer.from(o.user.id, "base64url").length).toBeGreaterThanOrEqual(16);
    expect(o.user.id).not.toContain(ana.id.replace(/-/g, ""));
    expect(o.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
    expect(o.attestation).toBe("none");
    expect(o.excludeCredentials).toEqual([]);
    // The challenge rides in a cookie sealed for this purpose and this player only.
    expect(openChallenge(cookies[CHALLENGE_COOKIE], "register", ana.id)?.challenge).toBe(o.challenge);
    expect(openChallenge(cookies[CHALLENGE_COOKIE], "signin", null)).toBeNull();
  });

  it("keeps a passkey the phone made and signed for this origin, and counts it", async () => {
    const before = await count("passkey_saved");
    anaKey = newPhoneKey();
    const { done } = await save(signedIn(ana), anaKey);
    expect(done?.result).toEqual({ ok: true, data: { saved: true } });
    // The answer and the cookie it leaves carry no credential id and no key.
    expect(JSON.stringify(done)).not.toContain(b64(anaKey.id));
    expect(done?.cookies[CHALLENGE_COOKIE]).toBeUndefined();
    const [row] = await rowsOf(ana.id);
    expect(row).toMatchObject({ id: b64(anaKey.id), counter: 0, deviceType: "multiDevice", backedUp: true, transports: ["internal", "hybrid"] });
    expect(await count("passkey_saved")).toBe(before + 1);
    // A second save lists the first in excludeCredentials, so the phone can say it remembers Ana already.
    const again = await asAction(signedIn(ana), () => passkeySaveOptionsAction());
    expect(again.result.ok && again.result.data.excludeCredentials?.map((c) => c.id)).toEqual([b64(anaKey.id)]);
  });

  it("refuses a session by name, at the options and at the answer", async () => {
    const bo = await createPlayer(db, { displayName: "Bo", locale: "en" });
    const byName = signedIn(bo, true);
    expect((await asAction(byName, () => passkeySaveOptionsAction())).result).toEqual({ ok: false, error: "forbidden" });
    // Even with a challenge sealed for Bo (one a full session of Bo once got), the answer is refused by name.
    const challenge = b64(randomBytes(32));
    const answer = registration(newPhoneKey(), challenge);
    const r = await asAction({ ...byName, [CHALLENGE_COOKIE]: sealChallenge("register", challenge, bo.id) }, () => passkeySaveAction(answer));
    expect(r.result).toEqual({ ok: false, error: "forbidden" });
    expect(await rowsOf(bo.id)).toEqual([]);
    // A browser that knows nobody may not save one either.
    expect((await asAction({}, () => passkeySaveOptionsAction())).result).toEqual({ ok: false, error: "forbidden" });
  });

  it("refuses a save signed for another origin, or without Face ID or a fingerprint", async () => {
    const cy = await createPlayer(db, { displayName: "Cy", locale: "en" });
    const before = await count("passkey_refused");
    expect((await save(signedIn(cy), newPhoneKey(), { origin: "https://kicksma.sh.evil.example" })).done?.result).toEqual({ ok: false, error: "invalid" });
    expect((await save(signedIn(cy), newPhoneKey(), { uv: false })).done?.result).toEqual({ ok: false, error: "invalid" });
    expect((await save(signedIn(cy), newPhoneKey(), { rpID: "evil.example" })).done?.result).toEqual({ ok: false, error: "invalid" });
    expect(await rowsOf(cy.id)).toEqual([]);
    expect(await count("passkey_refused")).toBe(before + 3);
  });

  it("refuses a save with another player's challenge, or a sign-in's", async () => {
    const dee = await createPlayer(db, { displayName: "Dee", locale: "en" });
    const ed = await createPlayer(db, { displayName: "Ed", locale: "en" });
    const opts = await asAction(signedIn(ed), () => passkeySaveOptionsAction());
    if (!opts.result.ok) throw new Error("no options");
    const answer = registration(newPhoneKey(), opts.result.data.challenge);
    // Ed's challenge in Dee's browser.
    expect((await asAction({ ...signedIn(dee), [CHALLENGE_COOKIE]: opts.cookies[CHALLENGE_COOKIE] }, () => passkeySaveAction(answer))).result).toEqual({ ok: false, error: "invalid" });
    const signin = await asAction({}, () => passkeySignInOptionsAction());
    if (!signin.result.ok) throw new Error("no options");
    const answer2 = registration(newPhoneKey(), signin.result.data.challenge);
    expect((await asAction({ ...signedIn(dee), [CHALLENGE_COOKIE]: signin.cookies[CHALLENGE_COOKIE] }, () => passkeySaveAction(answer2))).result).toEqual({ ok: false, error: "invalid" });
    expect(await rowsOf(dee.id)).toEqual([]);
  });

  it("asks any phone for its own passkeys: no list, Face ID or a fingerprint required", async () => {
    const { result, cookies } = await asAction({}, () => passkeySignInOptionsAction());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.allowCredentials ?? []).toEqual([]);
    expect(result.data.userVerification).toBe("required");
    expect(result.data.rpId).toBe(relyingParty().rpID);
    expect(openChallenge(cookies[CHALLENGE_COOKIE], "signin", null)?.challenge).toBe(result.data.challenge);
  });

  it("signs a browser that knows nobody in as the passkey's record, with a full session", async () => {
    const before = await count("signin_passkey");
    const refusedBefore = await count("passkey_refused");
    const { done } = await signIn({}, anaKey, 1);
    expect(done.result).toEqual({ ok: true, data: { name: "Ana", folded: false } });
    expect(unsealPlayerId(done.cookies[PLAYER_COOKIE])).toBe(ana.id);
    // A full session: the cookie carries no by-name mark.
    expect(done.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(ana.id));
    expect(await count("signin_passkey")).toBe(before + 1);
    expect(await count("passkey_refused")).toBe(refusedBefore);
    // The browser already signed in as Ana signs in again: nothing changes hands, so nothing is counted.
    const again = await signIn(signedIn(ana), anaKey, 2);
    expect(again.done.result).toEqual({ ok: true, data: { name: "Ana", folded: false } });
    expect(again.done.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(ana.id));
    expect(await count("signin_passkey")).toBe(before + 1);
    const [row] = await rowsOf(ana.id);
    expect(row.counter).toBe(2);
    expect(row.lastUsedAt).not.toBeNull();
  });

  it("refuses a challenge used twice: the cookie sent again, with the same answer or a new signature", async () => {
    const first = await signIn({}, anaKey, 3);
    expect(first.done.result.ok).toBe(true);
    // The same answer and the same cookie again, inside the five minutes.
    const replay = await asAction({ [CHALLENGE_COOKIE]: first.cookie }, () => passkeySignInAction(first.answer));
    expect(replay.result).toEqual({ ok: false, error: "invalid" });
    expect(replay.cookies[PLAYER_COOKIE]).toBeUndefined();
    // A fresh, valid signature over the spent challenge (a higher counter, as a real phone would send).
    const fresh = assertion(anaKey, first.opts.result.ok ? first.opts.result.data.challenge : "", 4);
    expect((await asAction({ [CHALLENGE_COOKIE]: first.cookie }, () => passkeySignInAction(fresh))).result).toEqual({ ok: false, error: "invalid" });
    // No cookie at all.
    expect((await asAction({}, () => passkeySignInAction(fresh))).result).toEqual({ ok: false, error: "invalid" });
  });

  it("refuses an answer signed over another challenge than the one in this browser's cookie", async () => {
    // A signature captured for an old challenge, sent with a fresh cookie: the cookie is good, the answer is not for it.
    const old = await asAction({}, () => passkeySignInOptionsAction());
    const fresh = await asAction({}, () => passkeySignInOptionsAction());
    if (!old.result.ok || !fresh.result.ok) throw new Error("no options");
    const stale = assertion(anaKey, old.result.data.challenge, 6);
    const r = await asAction({ [CHALLENGE_COOKIE]: fresh.cookies[CHALLENGE_COOKIE] }, () => passkeySignInAction(stale));
    expect(r.result).toEqual({ ok: false, error: "invalid" });
    expect(r.cookies[PLAYER_COOKIE]).toBeUndefined();
    // The same for a save.
    const opts = await asAction(signedIn(ana), () => passkeySaveOptionsAction());
    const other = await asAction(signedIn(ana), () => passkeySaveOptionsAction());
    if (!opts.result.ok || !other.result.ok) throw new Error("no options");
    const k = newPhoneKey();
    const saved = await asAction({ ...signedIn(ana), [CHALLENGE_COOKIE]: other.cookies[CHALLENGE_COOKIE] }, () => passkeySaveAction(registration(k, opts.result.ok ? opts.result.data.challenge : "")));
    expect(saved.result).toEqual({ ok: false, error: "invalid" });
    expect((await rowsOf(ana.id)).map((r) => r.id)).not.toContain(b64(k.id));
  });

  it("refuses a sign-in signed for another origin, another host, another type, or without Face ID or a fingerprint", async () => {
    const before = await count("passkey_refused");
    for (const o of [{ origin: "https://evil.example" }, { rpID: "evil.example" }, { type: "webauthn.create" }, { uv: false }] as Ceremony[]) {
      const { done } = await signIn({}, anaKey, 10, o);
      expect(done.result, JSON.stringify(o)).toEqual({ ok: false, error: "invalid" });
      expect(done.cookies[PLAYER_COOKIE]).toBeUndefined();
    }
    expect(await count("passkey_refused")).toBe(before + 4);
  });

  it("refuses a passkey nobody saved, one signed by another key, and one whose record was deleted", async () => {
    expect((await signIn({}, newPhoneKey(), 1)).done.result).toEqual({ ok: false, error: "invalid" });
    // Ana's credential id, signed by a stranger's key.
    const forged = { ...newPhoneKey(), id: anaKey.id };
    expect((await signIn({}, forged, 50)).done.result).toEqual({ ok: false, error: "invalid" });
    const gone = await createPlayer(db, { displayName: "Gus", locale: "en" });
    const k = newPhoneKey();
    expect((await save(signedIn(gone), k)).done?.result.ok).toBe(true);
    await db.update(players).set({ displayName: "Deleted player", personalToken: null }).where(eq(players.id, gone.id));
    expect((await signIn({}, k, 1)).done.result).toEqual({ ok: false, error: "invalid" });
  });

  it("folds the new record a browser made into the passkey's record: one record remains", async () => {
    const before = await count("signin_passkey_fold");
    const newAna = await createPlayer(db, { displayName: "Ana", locale: "en" });
    const { done } = await signIn(signedIn(newAna), anaKey, 20);
    expect(done.result).toEqual({ ok: true, data: { name: "Ana", folded: true } });
    expect(unsealPlayerId(done.cookies[PLAYER_COOKIE])).toBe(ana.id);
    expect(await exists(newAna.id)).toBe(false);
    expect(await count("signin_passkey_fold")).toBe(before + 1);
  });

  it("folds nothing for a browser signed in by name: the session only switches, to a full one", async () => {
    const byNameAna = await createPlayer(db, { displayName: "Ana", locale: "en" });
    const { done } = await signIn(signedIn(byNameAna, true), anaKey, 30);
    expect(done.result).toEqual({ ok: true, data: { name: "Ana", folded: false } });
    expect(done.cookies[PLAYER_COOKIE]).toBe(sealPlayerId(ana.id));
    expect(await exists(byNameAna.id)).toBe(true);
  });

  it("refuses a challenge used again after midnight UTC: the spend belongs to the challenge, not to the day", async () => {
    // A synced passkey (Apple, Google) reports 0 on every use, so its counter cannot stop a replay; the
    // spend is the only guard. It was a rate row of the day of the attempt, so a copy of the cookie and
    // the answer sent again after 00:00 UTC, inside the cookie's five minutes, met a fresh row and passed.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2031-03-04T23:57:00Z"));
      const hal = await createPlayer(db, { displayName: "Hal", locale: "en" });
      const k = newPhoneKey();
      expect((await save(signedIn(hal), k)).done?.result.ok).toBe(true);
      vi.setSystemTime(new Date("2031-03-04T23:58:00Z"));
      const opts = await asAction({}, () => passkeySignInOptionsAction());
      if (!opts.result.ok) throw new Error("no options");
      const cookie = opts.cookies[CHALLENGE_COOKIE];
      const answer = assertion(k, opts.result.data.challenge, 0);
      vi.setSystemTime(new Date("2031-03-04T23:59:00Z"));
      const first = await asAction({ [CHALLENGE_COOKIE]: cookie }, () => passkeySignInAction(answer));
      expect(first.result).toEqual({ ok: true, data: { name: "Hal", folded: false } });
      vi.setSystemTime(new Date("2031-03-05T00:01:00Z"));
      const replay = await asAction({ [CHALLENGE_COOKIE]: cookie }, () => passkeySignInAction(answer));
      expect(replay.result).toEqual({ ok: false, error: "invalid" });
      expect(replay.cookies[PLAYER_COOKIE]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens only a challenge cookie the server sealed, and only inside its five minutes", () => {
    const t0 = new Date("2031-03-06T10:00:00Z");
    const c = b64(randomBytes(32));
    const sealed = sealChallenge("signin", c, null, t0);
    expect(openChallenge(sealed, "signin", null, t0)?.challenge).toBe(c);
    expect(openChallenge(sealed, "signin", null, new Date(t0.getTime() + CHALLENGE_TTL_MS))?.challenge).toBe(c);
    // One millisecond past the five minutes.
    expect(openChallenge(sealed, "signin", null, new Date(t0.getTime() + CHALLENGE_TTL_MS + 1))).toBeNull();
    const [v, purpose, who, exp, , sig] = sealed.split(".");
    // A challenge the server never sealed, under the signature of one it did.
    expect(openChallenge([v, purpose, who, exp, b64(randomBytes(32)), sig].join("."), "signin", null, t0)).toBeNull();
    // A later expiry under the old signature: an old cookie made young again.
    expect(openChallenge([v, purpose, who, String(Number(exp) + 3_600_000), c, sig].join("."), "signin", null, t0)).toBeNull();
    // The signature with its first character changed. (Not the last: in base64url the last character
    // of 32 bytes carries two bits nobody reads, so some changes there decode to the same bytes.)
    expect(openChallenge([v, purpose, who, exp, c, (sig[0] === "A" ? "B" : "A") + sig.slice(1)].join("."), "signin", null, t0)).toBeNull();
    // A signature of the right length that the server never made.
    expect(openChallenge([v, purpose, who, exp, c, b64(randomBytes(32))].join("."), "signin", null, t0)).toBeNull();
  });

  it("refuses a sign-in whose cookie is past its five minutes, or was made young again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2031-03-07T10:00:00Z"));
      const ivy = await createPlayer(db, { displayName: "Ivy", locale: "en" });
      const k = newPhoneKey();
      expect((await save(signedIn(ivy), k)).done?.result.ok).toBe(true);
      const opts = await asAction({}, () => passkeySignInOptionsAction());
      if (!opts.result.ok) throw new Error("no options");
      const cookie = opts.cookies[CHALLENGE_COOKIE];
      // A good answer, captured with its cookie and never used.
      const answer = assertion(k, opts.result.data.challenge, 0);
      vi.setSystemTime(new Date(Date.parse("2031-03-07T10:00:00Z") + CHALLENGE_TTL_MS + 1_000));
      const late = await asAction({ [CHALLENGE_COOKIE]: cookie }, () => passkeySignInAction(answer));
      expect(late.result).toEqual({ ok: false, error: "invalid" });
      expect(late.cookies[PLAYER_COOKIE]).toBeUndefined();
      // The same cookie with its expiry moved on, the signature left as it was.
      const parts = cookie.split(".");
      parts[3] = String(Date.now() + CHALLENGE_TTL_MS);
      const young = await asAction({ [CHALLENGE_COOKIE]: parts.join(".") }, () => passkeySignInAction(answer));
      expect(young.result).toEqual({ ok: false, error: "invalid" });
      expect(young.cookies[PLAYER_COOKIE]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a save whose authenticator data names another passkey than the answer does, with the one plain refusal", async () => {
    const jo = await createPlayer(db, { displayName: "Jo", locale: "en" });
    const before = await count("passkey_refused");
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${String((a as { cause?: unknown }).cause ?? "")}` : String(a))).join(" ")));
    try {
      // An id of 3000 bytes inside the signed data, past the 1023 the standard allows; the answer's own id stays 16 bytes.
      const long = await save(signedIn(jo), newPhoneKey(), { authId: randomBytes(3000) });
      expect(long.done?.result).toEqual({ ok: false, error: "invalid" });
      // Another id of a fine length: the row would keep an id the phone never answers with.
      const other = await save(signedIn(jo), newPhoneKey(), { authId: randomBytes(16) });
      expect(other.done?.result).toEqual({ ok: false, error: "invalid" });
    } finally {
      spy.mockRestore();
    }
    expect(await rowsOf(jo.id)).toEqual([]);
    expect(await count("passkey_refused")).toBe(before + 2);
    expect(logged).toEqual([]);
  });

  it("logs no credential id and no public key when a passkey query fails", async () => {
    const kim = await createPlayer(db, { displayName: "Kim", locale: "en" });
    const k = newPhoneKey();
    expect((await save(signedIn(kim), k)).done?.result.ok).toBe(true);
    const opts = await asAction({}, () => passkeySignInOptionsAction());
    if (!opts.result.ok) throw new Error("no options");
    const answer = assertion(k, opts.result.data.challenge, 1);
    const logged: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${String((a as { cause?: unknown }).cause ?? "")}` : String(a))).join(" ")));
    // The table out of reach for one call, as a database that does not answer: the read by credential id fails.
    await db.execute(sql`alter table passkeys rename to passkeys_away`);
    try {
      const r = await asAction({ [CHALLENGE_COOKIE]: opts.cookies[CHALLENGE_COOKIE] }, () => passkeySignInAction(answer));
      expect(r.result).toEqual({ ok: false, error: "generic" });
    } finally {
      await db.execute(sql`alter table passkeys_away rename to passkeys`);
      spy.mockRestore();
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toContain(b64(k.id));
  });

  it("removes a player's own passkey by its handle, never another player's", async () => {
    const fay = await createPlayer(db, { displayName: "Fay", locale: "en" });
    const k = newPhoneKey();
    expect((await save(signedIn(fay), k)).done?.result.ok).toBe(true);
    const handle = passkeyHandle(fay.id, b64(k.id));
    // The raw credential id, or Fay's handle from another browser, removes nothing.
    expect((await asAction(signedIn(ana), () => removePasskeyAction(handle))).result).toEqual({ ok: false, error: "invalid" });
    expect((await asAction(signedIn(fay), () => removePasskeyAction(b64(k.id)))).result).toEqual({ ok: false, error: "invalid" });
    // A session by name proved nothing in its browser, so it may not take the player's way in away either.
    expect((await asAction(signedIn(fay, true), () => removePasskeyAction(handle))).result).toEqual({ ok: false, error: "forbidden" });
    expect((await rowsOf(fay.id)).length).toBe(1);
    expect((await asAction(signedIn(fay), () => removePasskeyAction(handle))).result).toEqual({ ok: true, data: null });
    expect(await rowsOf(fay.id)).toEqual([]);
    // And then the phone's copy signs in nobody.
    expect((await signIn({}, k, 1)).done.result).toEqual({ ok: false, error: "invalid" });
  });
});
