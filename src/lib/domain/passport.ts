/**
 * Player passport: a small signed document that says what level a player has
 * on Kicksmash, so a club, a partner or another app can check it without
 * asking us. Ed25519 over canonical JSON, keys as raw 32-byte hex, all through
 * WebCrypto so the same code verifies in Node, Deno, Bun and the browser.
 * The public key lives at /.well-known/kicksmash-passport.json.
 */
export type Passport = {
  v: 1;
  /** Issuer origin, e.g. https://kicksma.sh */
  iss: string;
  /** Key id: the first 8 hex characters of the public key. */
  kid: string;
  /** Subject: the public profile URL. */
  sub: string;
  name: string;
  level: number | null;
  band: string | null;
  /** An organizer who played with them confirmed the level. */
  verified: boolean;
  /** self (declared), adjusted (moved by results) or null. */
  source: string | null;
  played: number;
  won: number;
  issuedAt: string;
  expiresAt: string;
};

export type SignedPassport = Passport & { alg: "Ed25519"; sig: string };

const enc = new TextEncoder();

/** JSON with keys sorted at every level, no whitespace: the bytes both sides sign and verify. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// Fresh ArrayBuffer-backed arrays: WebCrypto wants BufferSource, and a SharedArrayBuffer-backed view would not do.
const hexToBytes = (hex: string): Uint8Array<ArrayBuffer> => {
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error("expected a 32-byte hex key");
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};
export const toBase64Url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const fromBase64Url = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export const keyId = (publicKeyHex: string) => publicKeyHex.slice(0, 8).toLowerCase();

const subtle = () => {
  const c = globalThis.crypto?.subtle;
  if (!c) throw new Error("WebCrypto is not available here");
  return c;
};

async function importPrivate(privateKeyHex: string, publicKeyHex: string): Promise<CryptoKey> {
  return subtle().importKey("jwk", { kty: "OKP", crv: "Ed25519", x: toBase64Url(hexToBytes(publicKeyHex)), d: toBase64Url(hexToBytes(privateKeyHex)) }, { name: "Ed25519" }, false, ["sign"]);
}
async function importPublic(publicKeyHex: string): Promise<CryptoKey> {
  return subtle().importKey("jwk", { kty: "OKP", crv: "Ed25519", x: toBase64Url(hexToBytes(publicKeyHex)) }, { name: "Ed25519" }, false, ["verify"]);
}

/** Signs the passport; the signature covers every field except alg and sig. */
export async function signPassport(doc: Passport, privateKeyHex: string, publicKeyHex: string): Promise<SignedPassport> {
  const key = await importPrivate(privateKeyHex, publicKeyHex);
  const sig = new Uint8Array(await subtle().sign({ name: "Ed25519" }, key, enc.encode(canonical(doc))));
  return { ...doc, alg: "Ed25519", sig: toBase64Url(sig) };
}

/** Checks the signature against a public key. Expiry is the caller's call (it is in the document). */
export async function verifyPassport(signed: SignedPassport, publicKeyHex: string): Promise<boolean> {
  try {
    const { alg, sig, ...doc } = signed;
    if (alg !== "Ed25519" || typeof sig !== "string") return false;
    if (signed.kid && signed.kid !== keyId(publicKeyHex)) return false;
    const key = await importPublic(publicKeyHex);
    return await subtle().verify({ name: "Ed25519" }, key, fromBase64Url(sig), enc.encode(canonical(doc)));
  } catch {
    return false;
  }
}

export const isExpired = (p: Pick<Passport, "expiresAt">, now = new Date()) => new Date(p.expiresAt).getTime() <= now.getTime();

/** The JWKS-style document served at /.well-known/kicksmash-passport.json. */
export function passportKeysDocument(issuer: string, publicKeyHex: string) {
  return { issuer, keys: [{ kid: keyId(publicKeyHex), kty: "OKP", crv: "Ed25519", alg: "Ed25519", x: toBase64Url(hexToBytes(publicKeyHex)), hex: publicKeyHex.toLowerCase() }], format: "Ed25519 over canonical JSON (keys sorted, no whitespace) of every field except alg and sig; sig is base64url.", docs: `${issuer}/developers#passport` };
}
