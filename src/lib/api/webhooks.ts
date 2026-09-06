import { createHmac, randomBytes } from "node:crypto";
import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/db";
import { webhookDeliveries, webhooks, type Webhook, type WebhookFilter } from "@/db/schema";
import { baseUrl } from "@/lib/config";
import { getGroupById } from "@/lib/domain/groups";
import { getEventByCode } from "@/lib/domain/queries";
import { LIMITS } from "@/lib/domain/ratelimit";
import { ApiError } from "./http";
import { matchToPublic, type PublicMatch } from "./serialize";

export const WEBHOOK_EVENTS = ["match.created", "match.updated", "match.joined", "match.left", "match.full", "match.cancelled", "match.result"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const RETRY_MINUTES = [1, 5, 30, 120, 720];
const MAX_ATTEMPTS = RETRY_MINUTES.length + 1;
const DISABLE_AFTER_FAILURES = 50;
const TIMEOUT_MS = 6000;

/** `t=<unix>,v1=<hex hmac of "<unix>.<body>">` in the X-Kicksmash-Signature header. */
export function sign(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

export function verifySignature(secret: string, header: string, body: string, toleranceSec = 300, now = Date.now()): boolean {
  const m = /t=(\d+),v1=([a-f0-9]{64})/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  return sign(secret, t, body) === `t=${t},v1=${m[2]}`;
}

export async function createWebhook(db: Db, keyId: string, input: { url: string; events?: string[]; filter?: WebhookFilter | null }): Promise<{ webhook: Webhook; secret: string }> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new ApiError(422, "invalid_request", "url must be an absolute https URL.");
  }
  if (url.protocol !== "https:" && !/^(localhost|127\.0\.0\.1)$/.test(url.hostname)) throw new ApiError(422, "invalid_request", "Webhook URLs must use https.", "http is accepted only for localhost while you test.");
  const events = (input.events?.length ? input.events : [...WEBHOOK_EVENTS]).filter((e): e is WebhookEvent => (WEBHOOK_EVENTS as readonly string[]).includes(e));
  if (events.length === 0) throw new ApiError(422, "invalid_request", `events must contain one or more of: ${WEBHOOK_EVENTS.join(", ")}.`);
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(webhooks).where(and(eq(webhooks.keyId, keyId), isNull(webhooks.disabledAt)));
  if (Number(n) >= LIMITS.webhooksPerKey) throw new ApiError(409, "limit", `A key can have ${LIMITS.webhooksPerKey} active webhooks. Delete one first.`);
  const secret = "whsec_" + randomBytes(24).toString("base64url");
  const filter: WebhookFilter | null = input.filter ? { venueSlug: input.filter.venueSlug ?? null, groupCode: input.filter.groupCode ?? null, codes: input.filter.codes?.slice(0, 50) ?? null } : null;
  const [webhook] = await db.insert(webhooks).values({ keyId, url: url.toString().slice(0, 500), events, filter, secret }).returning();
  return { webhook, secret };
}

export async function listWebhooks(db: Db, keyId: string): Promise<Webhook[]> {
  return db.select().from(webhooks).where(and(eq(webhooks.keyId, keyId), isNull(webhooks.disabledAt)));
}

export async function deleteWebhook(db: Db, keyId: string, id: string): Promise<boolean> {
  const rows = await db.update(webhooks).set({ disabledAt: new Date() }).where(and(eq(webhooks.id, id), eq(webhooks.keyId, keyId), isNull(webhooks.disabledAt))).returning({ id: webhooks.id });
  return rows.length > 0;
}

function matches(w: Webhook, event: string, m: PublicMatch): boolean {
  if (!w.events.includes(event)) return false;
  const f = w.filter;
  if (!f) return true;
  if (f.venueSlug && m.venue?.slug !== f.venueSlug) return false;
  if (f.groupCode && m.group?.code !== f.groupCode) return false;
  if (f.codes && f.codes.length && !f.codes.includes(m.code)) return false;
  return true;
}

async function attempt(db: Db, w: Webhook, deliveryId: string, event: string, payload: Record<string, unknown>, attempts: number, now = new Date()): Promise<boolean> {
  const body = JSON.stringify({ id: deliveryId, event, createdAt: now.toISOString(), data: payload });
  const ts = Math.floor(now.getTime() / 1000);
  let status = 0;
  let error: string | null = null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(w.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "Kicksmash-Webhooks/1.0 (+https://kicksma.sh/developers)", "X-Kicksmash-Event": event, "X-Kicksmash-Delivery": deliveryId, "X-Kicksmash-Signature": sign(w.secret, ts, body) },
      body,
      signal: ctrl.signal,
      redirect: "manual",
    });
    clearTimeout(timer);
    status = res.status;
    if (!(status >= 200 && status < 300)) error = `HTTP ${status}`;
  } catch (e) {
    error = String((e as Error)?.message ?? e).slice(0, 300);
  }
  const ok = !error;
  const next = ok || attempts + 1 >= MAX_ATTEMPTS ? null : new Date(now.getTime() + RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length - 1)] * 60_000);
  await db
    .update(webhookDeliveries)
    .set({ attempts: attempts + 1, lastStatus: status || null, lastError: error, deliveredAt: ok ? now : null, nextAttemptAt: next })
    .where(eq(webhookDeliveries.id, deliveryId));
  if (ok) await db.update(webhooks).set({ failures: 0 }).where(eq(webhooks.id, w.id));
  else {
    const [row] = await db.update(webhooks).set({ failures: sql`${webhooks.failures} + 1` }).where(eq(webhooks.id, w.id)).returning({ failures: webhooks.failures });
    if ((row?.failures ?? 0) >= DISABLE_AFTER_FAILURES) await db.update(webhooks).set({ disabledAt: now }).where(eq(webhooks.id, w.id));
  }
  return ok;
}

/** Fan a match event out to every matching active webhook; first attempt inline, retries by cron. */
export async function dispatch(db: Db, event: WebhookEvent, match: PublicMatch, extra: Record<string, unknown> = {}, now = new Date()): Promise<number> {
  const active = await db.select().from(webhooks).where(isNull(webhooks.disabledAt)).limit(500);
  const targets = active.filter((w) => matches(w, event, match));
  if (targets.length === 0) return 0;
  const payload = { match, ...extra };
  let sent = 0;
  for (const w of targets) {
    const [d] = await db.insert(webhookDeliveries).values({ webhookId: w.id, event, payload, nextAttemptAt: now }).returning({ id: webhookDeliveries.id });
    if (await attempt(db, w, d.id, event, payload, 0, now)) sent++;
  }
  return sent;
}

/** Load a match by code and dispatch. Safe to call from after(): never throws. */
export async function emitMatchEvent(db: Db, event: WebhookEvent, code: string, extra: Record<string, unknown> = {}): Promise<void> {
  try {
    const detail = await getEventByCode(db, code);
    if (!detail) return;
    const group = detail.event.groupId ? await getGroupById(db, detail.event.groupId) : null;
    await dispatch(db, event, matchToPublic(detail, baseUrl(), group ? { code: group.code, name: group.name } : null), extra);
  } catch (e) {
    console.warn("[webhooks] emit failed", event, code, e);
  }
  // Every change also reaches the Telegram cards (edited in place; the result is posted once). Loaded lazily: the bot imports the operations.
  try {
    const bot = await import("@/lib/telegram/bot");
    if (event === "match.result") await bot.postTelegramResult(db, code);
    await bot.syncTelegram(db, code);
    if (event === "match.cancelled") await bot.postTelegramNotice(db, code, "cancelled");
    else if (event === "match.updated" && extra.calendarChanged === true) await bot.postTelegramNotice(db, code, "updated");
  } catch (e) {
    console.warn("[telegram] sync failed", event, code, e);
  }
  try {
    const bot = await import("@/lib/discord/bot");
    if (event === "match.result") await bot.postDiscordResult(db, code);
    await bot.syncDiscord(db, code);
  } catch (e) {
    console.warn("[discord] sync failed", event, code, e);
  }
}

/** Hourly: retry what failed, oldest first, bounded so the cron stays well inside its time budget. */
export async function processWebhookRetries(db: Db, now = new Date(), max = 50): Promise<{ attempted: number; delivered: number }> {
  const due = await db
    .select({ d: webhookDeliveries, w: webhooks })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveries.webhookId))
    .where(and(isNull(webhookDeliveries.deliveredAt), lte(webhookDeliveries.nextAttemptAt, now), isNull(webhooks.disabledAt)))
    .orderBy(webhookDeliveries.nextAttemptAt)
    .limit(max);
  let delivered = 0;
  for (const { d, w } of due) {
    if (d.attempts >= MAX_ATTEMPTS) continue;
    if (await attempt(db, w, d.id, d.event, d.payload, d.attempts, now)) delivered++;
  }
  return { attempted: due.length, delivered };
}
