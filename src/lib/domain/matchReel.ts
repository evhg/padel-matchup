import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { events, matchReels } from "@/db/schema";
import { newReelToken } from "@/lib/codes";
import { linksIn } from "@/lib/domain/bookingLink";
import { DomainError } from "@/lib/domain/errors";
import { isSeated } from "@/lib/domain/highlights";
import { fromBase64Url, toBase64Url } from "@/lib/domain/passport";

/**
 * The highlights reel of a filmed match: where it plays from, and for how long.
 *
 * The owner, 23 November 2026: a player of the match sees the reel on the match page; a reel is kept
 * for 30 days on the store. The files are on the reel host (`scripts/highlights/modal/serve.py`), under
 * a token that is the only key to them, so a reel's address is made here and nowhere else.
 */

/** The steps a reel goes through. "ready" is the only one with a reel to show. */
export const REEL_STATUS = ["asked", "received", "working", "ready", "failed"] as const;
export type ReelStatus = (typeof REEL_STATUS)[number];
/** A reel is kept this long after it is ready (the reel host's daily job deletes it, to the day). */
export const REEL_KEEP_DAYS = 30;

/** A player's match video is deleted from the store this long after it arrived (the owner, 23 November 2026). */
export const VIDEO_KEEP_DAYS = 7;
/** The match page asks "Did you film it?" for this long after the start. A film is still accepted after it. */
export const REEL_SEND_DAYS = 14;

const TOKEN = /^[A-Za-z0-9_-]{22,64}$/;

/** The reel host's address as a row keeps it: https, a host name, no path, no slash at the end. Pure. */
export function reelHostOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || (u.pathname !== "/" && u.pathname !== "")) return null;
  return `https://${u.host}`;
}

export const isReelToken = (raw: unknown): raw is string => typeof raw === "string" && TOKEN.test(raw);

export type ReelView = { tall: string; wide: string; saveTall: string; saveWide: string; keptUntil: Date };

/** What a screen needs of a row, or null when there is no reel to show (not ready, or past its days). Pure. */
export function reelView(row: { status: string; host: string | null; reelToken: string; readyAt: Date | null } | null | undefined, now: Date): ReelView | null {
  if (!row || row.status !== "ready" || !row.readyAt) return null;
  const host = reelHostOf(row.host);
  if (!host || !isReelToken(row.reelToken)) return null;
  const keptUntil = new Date(row.readyAt.getTime() + REEL_KEEP_DAYS * 86_400_000);
  if (keptUntil.getTime() <= now.getTime()) return null;
  const base = `${host}/r/${row.reelToken}`;
  return { tall: `${base}/tall.mp4`, wide: `${base}/wide.mp4`, saveTall: `${base}/tall.mp4?dl=1`, saveWide: `${base}/wide.mp4?dl=1`, keptUntil };
}

/** The reel of one match for its page. One read on the match's own unique index. */
export async function matchReel(db: Db, eventId: string, now = new Date()): Promise<ReelView | null> {
  const [row] = await db.select({ status: matchReels.status, host: matchReels.host, reelToken: matchReels.reelToken, readyAt: matchReels.readyAt }).from(matchReels).where(eq(matchReels.eventId, eventId)).limit(1);
  return reelView(row, now);
}

/**
 * Where a match stands with its reel, for the match page:
 *   "none"     nobody sent a video (or the reel is past its days, or the last try failed): offer to send one
 *   "sending"  a player started an upload that is not finished: the same card, so the upload can go on
 *   "here"     the video is here (an upload that finished, or a link) and the reel is in work
 *   "ready"    the reel plays
 */
export type ReelState = { kind: "none"; failed: boolean } | { kind: "sending" } | { kind: "here"; source: string | null } | { kind: "ready"; view: ReelView };

/** Pure: a row, or no row, as what the page shows. */
export function reelStateOf(row: { status: string; host: string | null; reelToken: string; readyAt: Date | null; source: string | null } | null | undefined, now: Date): ReelState {
  if (!row) return { kind: "none", failed: false };
  const view = reelView(row, now);
  if (view) return { kind: "ready", view };
  if (row.status === "asked") return { kind: "sending" };
  if (row.status === "received" || row.status === "working") return { kind: "here", source: row.source };
  return { kind: "none", failed: row.status === "failed" };
}

/** One read on the match's own unique index. */
export async function reelState(db: Db, eventId: string, now = new Date()): Promise<ReelState> {
  const [row] = await db.select({ status: matchReels.status, host: matchReels.host, reelToken: matchReels.reelToken, readyAt: matchReels.readyAt, source: matchReels.source }).from(matchReels).where(eq(matchReels.eventId, eventId)).limit(1);
  return reelStateOf(row, now);
}

// ---- A player sends the match video (the owner, 23 November 2026: an upload to the store, or a link) ----

/** One match video, at most. A 4K film of 97 minutes is 44 GB; the reel host holds the same number. */
export const UPLOAD_MAX_BYTES = 80 * 2 ** 30;
/** A ticket lives this long: a slow line needs hours for 44 GB, and an upload that stopped can go on the next day. */
export const TICKET_TTL_MS = 48 * 3600 * 1000;
/** What the key signs before the payload, so a ticket can never be read as a passport, nor a passport as a ticket. */
export const TICKET_PREFIX = "kicksmash-reel-upload.";

const enc = new TextEncoder();
const hexToBytes = (hex: string) => new Uint8Array((hex.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const edKey = (publicHex: string, privateHex: string | null, use: "sign" | "verify") =>
  globalThis.crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: toBase64Url(hexToBytes(publicHex)), ...(privateHex ? { d: toBase64Url(hexToBytes(privateHex)) } : {}) }, { name: "Ed25519" }, false, [use]);

/**
 * The ticket a browser shows the reel host with each part of an upload: `<payload>.<signature>`, both
 * base64url. The payload says which upload (`t`), until when (`exp`, seconds) and how large (`max`,
 * bytes). Kicksmash signs it with its Ed25519 key and the reel host checks it with the public half
 * (`read_ticket` in `scripts/highlights/modal/serve.py`), so the two share no secret.
 */
export async function signUploadTicket(token: string, keys: { priv: string; pub: string }, now: Date): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify({ exp: Math.floor((now.getTime() + TICKET_TTL_MS) / 1000), max: UPLOAD_MAX_BYTES, p: "reel-upload", t: token })));
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign({ name: "Ed25519" }, await edKey(keys.pub, keys.priv, "sign"), enc.encode(TICKET_PREFIX + body)));
  return `${body}.${toBase64Url(sig)}`;
}

/** The upload a ticket is for, or null: a ticket that is not ours, was changed, or is past its time. */
export async function readUploadTicket(ticket: unknown, publicHex: string, now: Date): Promise<string | null> {
  if (typeof ticket !== "string" || ticket.length > 2000) return null;
  const [body, sig, more] = ticket.split(".");
  if (!body || !sig || more !== undefined) return null;
  try {
    if (!(await globalThis.crypto.subtle.verify({ name: "Ed25519" }, await edKey(publicHex, null, "verify"), fromBase64Url(sig), enc.encode(TICKET_PREFIX + body)))) return null;
    const t = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as { t?: unknown; exp?: unknown };
    return isReelToken(t.t) && typeof t.exp === "number" && t.exp * 1000 > now.getTime() ? t.t : null;
  } catch {
    return null;
  }
}

/** Where a shared link to a film may be: the drives a phone puts a large video on. */
const LINK_HOSTS = ["icloud.com", "drive.google.com", "docs.google.com", "photos.app.goo.gl", "photos.google.com", "dropbox.com", "1drv.ms", "onedrive.live.com"];

/**
 * The one link a match keeps, from whatever was pasted: a bare link, or a share text with the link in it.
 * https only, on a drive in `LINK_HOSTS`; anything else is null. Pure, and safe in a browser.
 */
export function videoLinkOf(raw: unknown): string | null {
  const text = typeof raw === "string" ? raw.trim().slice(0, 4000) : "";
  if (!text) return null;
  const candidates = /\s/.test(text) ? linksIn(text) : [/^[a-z]+:\/\//i.test(text) ? text : `https://${text}`];
  for (const c of candidates) {
    let u: URL;
    try {
      u = new URL(c);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:" || u.username || u.password) continue;
    if (!LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    if (u.pathname.length <= 1 && !u.search && !u.hash) continue; // the drive's front page is not a film
    return u.toString().slice(0, 2000);
  }
  return null;
}

/** The organiser or a player with a place, in a match that has started and was not cancelled. */
async function senderOf(db: Db, eventId: string, playerId: string, now: Date) {
  const [ev] = await db.select({ id: events.id, code: events.code, type: events.type, status: events.status, startsAt: events.startsAt, creatorPlayerId: events.creatorPlayerId }).from(events).where(eq(events.id, eventId)).limit(1);
  if (!ev || ev.type !== "match") throw new DomainError("not_found");
  if (ev.status === "cancelled") throw new DomainError("cancelled");
  if (ev.startsAt.getTime() > now.getTime()) throw new DomainError("not_started");
  if (ev.creatorPlayerId !== playerId && !(await isSeated(db, ev.id, playerId))) throw new DomainError("forbidden");
  const [row] = await db.select().from(matchReels).where(eq(matchReels.eventId, ev.id)).limit(1);
  // A video that is here, and a reel that plays, are not written over by a second player.
  if (row && (row.status === "received" || row.status === "working" || reelView(row, now))) throw new DomainError("locked");
  return { ev, row };
}

/**
 * "Choose the video": the token of this match's upload. A first call makes the row; a call while an
 * upload is not finished gives the same token, so any of the four players can go on with it.
 */
export async function askReelUpload(db: Db, input: { eventId: string; playerId: string; now?: Date }): Promise<{ token: string; code: string }> {
  const now = input.now ?? new Date();
  const { ev, row } = await senderOf(db, input.eventId, input.playerId, now);
  if (row?.status === "asked" && row.source === "upload") return { token: row.reelToken, code: ev.code };
  const values = { status: "asked" satisfies ReelStatus, source: "upload", sourceUrl: null, reelToken: newReelToken(), requestedBy: input.playerId, host: null, readyAt: null, note: null };
  await db.insert(matchReels).values({ eventId: ev.id, ...values }).onConflictDoUpdate({ target: matchReels.eventId, set: values });
  return { token: values.reelToken, code: ev.code };
}

/** "Paste a link": the match keeps the link to the film, and the video counts as here. */
export async function setReelLink(db: Db, input: { eventId: string; playerId: string; text: unknown; now?: Date }): Promise<{ code: string }> {
  const now = input.now ?? new Date();
  const url = videoLinkOf(input.text);
  if (!url) throw new DomainError("invalid", "link");
  const { ev } = await senderOf(db, input.eventId, input.playerId, now);
  const values = { status: "received" satisfies ReelStatus, source: "link", sourceUrl: url, reelToken: newReelToken(), requestedBy: input.playerId, host: null, readyAt: null, note: null };
  await db.insert(matchReels).values({ eventId: ev.id, ...values }).onConflictDoUpdate({ target: matchReels.eventId, set: values });
  return { code: ev.code };
}

/**
 * The reel host says "the film of this upload is joined": the row goes from asked to received. Answers
 * the match's code when this call changed the row, and null when there was nothing to change (a second
 * call, or a token nobody asked for), so the caller tells the owner once.
 */
export async function reelUploadReceived(db: Db, token: string): Promise<string | null> {
  const changed = await db
    .update(matchReels)
    .set({ status: "received" satisfies ReelStatus })
    .where(and(eq(matchReels.reelToken, token), eq(matchReels.status, "asked"), eq(matchReels.source, "upload")))
    .returning({ eventId: matchReels.eventId });
  if (changed.length === 0) return null;
  const [ev] = await db.select({ code: events.code }).from(events).where(eq(events.id, changed[0].eventId)).limit(1);
  return ev?.code ?? null;
}

/**
 * The operator says "the reel of this match is on the store": the row is written as ready, or an older
 * row of the match is replaced. Refuses a match that has not started, a host that is not an https
 * address and a token of the wrong shape, each before any write.
 */
export async function setMatchReel(db: Db, input: { code: string; host: unknown; token: unknown; now?: Date }): Promise<{ eventId: string; replaced: boolean }> {
  const now = input.now ?? new Date();
  const host = reelHostOf(input.host);
  if (!host) throw new DomainError("invalid", "host");
  if (!isReelToken(input.token)) throw new DomainError("invalid", "token");
  const [ev] = await db.select({ id: events.id, startsAt: events.startsAt, status: events.status }).from(events).where(eq(events.code, input.code)).limit(1);
  if (!ev || ev.status === "cancelled") throw new DomainError("not_found");
  if (ev.startsAt.getTime() > now.getTime()) throw new DomainError("not_started");
  const [old] = await db.select({ id: matchReels.id }).from(matchReels).where(eq(matchReels.eventId, ev.id)).limit(1);
  const values = { status: "ready" satisfies ReelStatus, host, reelToken: input.token, readyAt: now, note: null };
  await db
    .insert(matchReels)
    .values({ eventId: ev.id, source: "operator", ...values })
    .onConflictDoUpdate({ target: matchReels.eventId, set: values });
  return { eventId: ev.id, replaced: Boolean(old) };
}

/** The operator takes a reel off the match page. The files stay on the store until their days end. */
export async function removeMatchReel(db: Db, code: string): Promise<boolean> {
  const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.code, code)).limit(1);
  if (!ev) throw new DomainError("not_found");
  const gone = await db.delete(matchReels).where(eq(matchReels.eventId, ev.id)).returning({ id: matchReels.id });
  return gone.length > 0;
}
