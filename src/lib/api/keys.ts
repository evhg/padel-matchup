import { createHash, randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { apiKeys, type ApiKey } from "@/db/schema";
import { LIMITS, takeRate } from "@/lib/domain/ratelimit";
import { normalizeEmail } from "@/lib/domain/players";
import { ApiError, clientIp } from "./http";

export const KEY_PREFIX = "ks_live_";

export function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateKey(): { key: string; hash: string; prefix: string } {
  const key = KEY_PREFIX + randomBytes(24).toString("base64url");
  return { key, hash: hashKey(key), prefix: key.slice(0, KEY_PREFIX.length + 6) + "…" };
}

/** Instant, no approval: anyone (a person or an assistant) gets a key. The key is shown once. */
export async function createApiKey(db: Db, input: { name: string; email?: string | null; agent?: string | null }): Promise<{ key: string; record: ApiKey }> {
  const name = (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) throw new ApiError(422, "invalid_request", "name is required: who or what will use this key.", 'For example {"name": "Thursday crew bot", "agent": "claude"}.');
  const { key, hash, prefix } = generateKey();
  const [record] = await db
    .insert(apiKeys)
    .values({ keyHash: hash, prefix, name, email: normalizeEmail(input.email), agent: (input.agent ?? "").trim().slice(0, 80) || null })
    .returning();
  return { key, record };
}

/** Bearer key → record, or null when the request carries none. A revoked or unknown key is an error, not anonymity. */
export async function authenticate(db: Db, req: Request): Promise<ApiKey | null> {
  const auth = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(auth);
  const raw = m?.[1] ?? req.headers.get("x-api-key") ?? null;
  if (!raw) return null;
  if (!raw.startsWith(KEY_PREFIX)) throw new ApiError(401, "invalid_key", "That does not look like a Kicksmash key.", `Keys start with ${KEY_PREFIX}. Get one with POST /api/v1/keys.`);
  const [rec] = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, hashKey(raw))).limit(1);
  if (!rec || rec.revokedAt) throw new ApiError(401, "invalid_key", "This key is unknown or revoked.", "Get a new one with POST /api/v1/keys.");
  await db
    .update(apiKeys)
    .set({ calls: sql`${apiKeys.calls} + 1`, lastUsedAt: new Date() })
    .where(eq(apiKeys.id, rec.id));
  return rec;
}

export type Caller = { key: ApiKey | null; ip: string };

export async function caller(db: Db, req: Request): Promise<Caller> {
  return { key: await authenticate(db, req), ip: clientIp(req) };
}

/** Per-key when there is one, per-IP otherwise. Throws 429 with a hint that says how to get more room. */
export async function guard(db: Db, c: Caller, scope: "read" | "write" | "mcp" | "keys"): Promise<void> {
  let ok = true;
  if (scope === "read") ok = await takeRate(db, "api_read", c.key ? `k:${c.key.id}` : `ip:${c.ip}`, c.key ? LIMITS.apiReadsPerIpPerHour * 5 : LIMITS.apiReadsPerIpPerHour, "hour");
  else if (scope === "mcp") ok = await takeRate(db, "mcp", c.key ? `k:${c.key.id}` : `ip:${c.ip}`, c.key ? LIMITS.mcpCallsPerIpPerHour * 5 : LIMITS.mcpCallsPerIpPerHour, "hour");
  else if (scope === "write") ok = c.key ? await takeRate(db, "api_write", `k:${c.key.id}`, LIMITS.apiWritesPerKeyPerDay) : await takeRate(db, "api_write", `ip:${c.ip}`, LIMITS.apiWritesPerIpPerDay);
  else ok = await takeRate(db, "api_keys", `ip:${c.ip}`, LIMITS.apiKeysPerIpPerDay);
  if (!ok) {
    throw new ApiError(
      429,
      "rate_limited",
      scope === "write" && !c.key ? `Without a key you can create or join up to ${LIMITS.apiWritesPerIpPerDay} times a day from one address.` : "Too many requests for now.",
      c.key ? "Limits reset hourly (reads) and daily (writes). Tell us if you need more: the address is on /developers." : "Get a free key with POST /api/v1/keys and send it as Authorization: Bearer <key> for roomier limits.",
    );
  }
}
