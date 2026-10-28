import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { relyingParty } from "@/lib/passkeys/webauthn";
import { PLAYER_COOKIE, sealPlayerId } from "@/lib/session";

/**
 * The phone and the browser of the passkey tests (tests/passkey-ceremony.test.ts, tests/passkey-autofill.test.ts):
 * a P-256 key pair made with node:crypto, and the attestation and the assertion a platform authenticator
 * builds over a challenge (authenticator data, client data with the challenge, the origin and the type,
 * the signature), as the browser hands them to the actions.
 */

// ------------------------------------------------------------------ the phone

/** CBOR, the little of it WebAuthn needs: whole numbers, text, bytes and maps (a Map keeps number keys). */
export function cbor(v: unknown): Buffer {
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

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest();
export const b64 = (b: Buffer) => b.toString("base64url");
export const counterBytes = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
/** Authenticator data flags: user present, user verified, backup eligible, backed up, attested credential data. */
export const UP = 0x01;
export const UV = 0x04;
export const BE = 0x08;
export const BS = 0x10;
export const AT = 0x40;

export type PhoneKey = { privateKey: KeyObject; id: Buffer; cose: Buffer };

/** A new passkey, as a phone makes one: a P-256 key pair and a random credential id. */
export function newPhoneKey(): PhoneKey {
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
export type Ceremony = { origin?: string; rpID?: string; uv?: boolean; type?: string; authId?: Buffer };

/** What `navigator.credentials.create` returns for this key: attestation "none", the challenge and the origin in the client data. */
export function registration(k: PhoneKey, challenge: string, o: Ceremony = {}) {
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
export function assertion(k: PhoneKey, challenge: string, counter: number, o: Ceremony = {}) {
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

export type Jar = Record<string, string>;
export const signedIn = (p: { id: string }, byName = false): Jar => ({ [PLAYER_COOKIE]: sealPlayerId(p.id, { byName }) });
