import { and, eq, inArray, ne } from "drizzle-orm";
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

/**
 * Why a reel from the whole film has no score box, no winner of each point and no numbers (the owner, 27 November 2026:
 * they appear only when the engine is sure). The reel's job decides (`scripts/highlights/honest.py`) and says it with
 * the finished reel (`noScore`); the match page says it in one line under the reel (`NO_SCORE_LINE`).
 *   no_score     the match has no set score to check the points against
 *   few_points   the sound found fewer points than the set scores need
 *   no_winners   the engine cannot yet tell who won each point
 */
export const NO_SCORE_WHY = ["no_score", "few_points", "no_winners"] as const;
export type NoScoreWhy = (typeof NO_SCORE_WHY)[number];
/** The one plain line under such a reel, by its reason: a key of `reel` in messages/. */
export const NO_SCORE_LINE = { no_score: "noScoreResult", few_points: "noScoreFew", no_winners: "noScoreWinners" } as const satisfies Record<NoScoreWhy, string>;
export const noScoreWhyOf = (raw: unknown): NoScoreWhy | null => ((NO_SCORE_WHY as readonly unknown[]).includes(raw) ? (raw as NoScoreWhy) : null);

/** The note of a ready row: `{"noScore": "<code>"}` when the reel has no score (`setMatchReel`), else null. Pure. */
export function readyNoteOf(note: string | null | undefined): NoScoreWhy | null {
  try {
    return noScoreWhyOf((JSON.parse(note ?? "") as { noScore?: unknown } | null)?.noScore);
  } catch {
    return null;
  }
}

/**
 * `poster`: a frame of the opening, shown before the reel plays (`poster.jpg` beside the films; older reels have none).
 * `share`: the reel's public version (`share.mp4`: no branding, the match sound only), the only file that goes to
 * TikTok; older reels have none, so "Share to TikTok" asks the reel host first (`shareFileThere`).
 * `noScore`: why the reel has no score, for the one line under it; null for a reel that claims nothing it lacks.
 */
export type ReelView = { tall: string; wide: string; share: string; saveTall: string; saveWide: string; poster: string; keptUntil: Date; noScore: NoScoreWhy | null };

/** What a screen needs of a row, or null when there is no reel to show (not ready, or past its days). Pure. */
export function reelView(row: { status: string; host: string | null; reelToken: string; readyAt: Date | null; note?: string | null } | null | undefined, now: Date): ReelView | null {
  if (!row || row.status !== "ready" || !row.readyAt) return null;
  const host = reelHostOf(row.host);
  if (!host || !isReelToken(row.reelToken)) return null;
  const keptUntil = new Date(row.readyAt.getTime() + REEL_KEEP_DAYS * 86_400_000);
  if (keptUntil.getTime() <= now.getTime()) return null;
  const base = `${host}/r/${row.reelToken}`;
  return { tall: `${base}/tall.mp4`, wide: `${base}/wide.mp4`, share: `${base}/share.mp4`, saveTall: `${base}/tall.mp4?dl=1`, saveWide: `${base}/wide.mp4?dl=1`, poster: `${base}/poster.jpg`, keptUntil, noScore: readyNoteOf(row.note) };
}

/** The reel of one match for its page. One read on the match's own unique index. */
export async function matchReel(db: Db, eventId: string, now = new Date()): Promise<ReelView | null> {
  const [row] = await db.select({ status: matchReels.status, host: matchReels.host, reelToken: matchReels.reelToken, readyAt: matchReels.readyAt, note: matchReels.note }).from(matchReels).where(eq(matchReels.eventId, eventId)).limit(1);
  return reelView(row, now);
}

/**
 * The reel of a match found by its code, for the routes that have only the code ("Share to TikTok": the start,
 * the post and the file TikTok pulls). One statement: the match's unique code index, then the reel's own.
 */
export async function matchReelByCode(db: Db, code: string, now = new Date()): Promise<ReelView | null> {
  const [row] = await db
    .select({ status: matchReels.status, host: matchReels.host, reelToken: matchReels.reelToken, readyAt: matchReels.readyAt, note: matchReels.note })
    .from(events)
    .innerJoin(matchReels, eq(matchReels.eventId, events.id))
    .where(and(eq(events.code, code), eq(events.type, "match")))
    .limit(1);
  return reelView(row, now);
}

/**
 * Where a match stands with its reel, for the match page:
 *   "none"     nobody sent a video (or the reel is past its days, or the last try failed): offer to send one
 *   "sending"  a player started an upload that is not finished: the same card, so the upload can go on
 *   "here"     the video is here (an upload that finished, or a link) and the reel is in work
 *   "ready"    the reel plays
 */
/** What the maker does now, as a key the page translates (`reel.step.<key>`). */
export const REEL_STEPS = ["clips", "players", "follow", "replays", "opening", "music", "finish"] as const;
export type ReelStep = (typeof REEL_STEPS)[number];
const stepOf = (v: unknown): ReelStep | null => ((REEL_STEPS as readonly string[]).includes(String(v)) ? (String(v) as ReelStep) : null);
/**
 * `names`: the maker waits for the players to say who is who (`scripts/highlights/modal/fastreel.py`, "Names"). The
 * question is `{host}/r/{upload}/names.json` with a face picture for each player it saw, and the answer goes to the
 * reel host with a ticket of that upload (`namesTicketAction`).
 */
export type ReelProgress = { pct: number; readyBy: Date; step: ReelStep | null; names: { host: string; upload: string } | null };
export type ReelState = { kind: "none"; failed: boolean } | { kind: "sending" } | { kind: "here"; source: string | null } | { kind: "working"; progress: ReelProgress } | { kind: "ready"; view: ReelView };

/** The progress the reel's maker last reported (`setReelProgress`), from the row's note; null when there is none. */
export function progressOf(note: string | null | undefined): ReelProgress | null {
  try {
    const j = JSON.parse(note ?? "") as { pct?: unknown; readyBy?: unknown; step?: unknown; waiting?: unknown; host?: unknown; upload?: unknown };
    const pct = Number(j.pct);
    const readyBy = new Date(String(j.readyBy));
    if (!Number.isFinite(pct) || Number.isNaN(readyBy.getTime())) return null;
    const host = reelHostOf(j.host);
    const names = j.waiting === "names" && host && isReelToken(j.upload) ? { host, upload: j.upload } : null;
    return { pct: Math.max(0, Math.min(100, Math.round(pct))), readyBy, step: stepOf(j.step), names };
  } catch {
    return null;
  }
}

/** Pure: a row, or no row, as what the page shows. */
export function reelStateOf(row: { status: string; host: string | null; reelToken: string; readyAt: Date | null; source: string | null; note?: string | null } | null | undefined, now: Date): ReelState {
  if (!row) return { kind: "none", failed: false };
  const view = reelView(row, now);
  if (view) return { kind: "ready", view };
  if (row.status === "asked") return { kind: "sending" };
  // The maker reports its progress: a bar and the minutes left, never "in work" with nothing behind it.
  const progress = row.status === "working" ? progressOf(row.note) : null;
  if (progress) return { kind: "working", progress };
  if (row.status === "received" || row.status === "working") return { kind: "here", source: row.source };
  return { kind: "none", failed: row.status === "failed" };
}

/** One read on the match's own unique index. */
export async function reelState(db: Db, eventId: string, now = new Date()): Promise<ReelState> {
  const [row] = await db.select({ status: matchReels.status, host: matchReels.host, reelToken: matchReels.reelToken, readyAt: matchReels.readyAt, source: matchReels.source, note: matchReels.note }).from(matchReels).where(eq(matchReels.eventId, eventId)).limit(1);
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

/**
 * The key the fast reel's job reports with (`scripts/highlights/modal/fastreel.py`): Kicksmash signs it, in the
 * answer to the reel host when the clips are here, for the codes of that upload alone, for three days (a reel can
 * wait for the players' names overnight). `/api/reel/report` takes it for those codes, and only for the progress
 * and the finished reel. So no operator secret of Kicksmash lives on the reel host.
 */
export const REPORT_PREFIX = "kicksmash-reel-report.";
export const REPORT_TTL_MS = 72 * 3600 * 1000;
const CODE = /^[A-Za-z0-9]{4}$/;

export async function signReelReport(codes: readonly string[], keys: { priv: string; pub: string }, now: Date): Promise<string> {
  const body = toBase64Url(enc.encode(JSON.stringify({ c: codes.filter((c) => CODE.test(c)), exp: Math.floor((now.getTime() + REPORT_TTL_MS) / 1000), p: "reel-report" })));
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign({ name: "Ed25519" }, await edKey(keys.pub, keys.priv, "sign"), enc.encode(REPORT_PREFIX + body)));
  return `${body}.${toBase64Url(sig)}`;
}

/** The match codes a report key is for, or null: a key that is not ours, was changed, or is past its time. */
export async function readReelReport(key: unknown, publicHex: string, now: Date): Promise<string[] | null> {
  if (typeof key !== "string" || key.length > 2000) return null;
  const [body, sig, more] = key.split(".");
  if (!body || !sig || more !== undefined) return null;
  try {
    if (!(await globalThis.crypto.subtle.verify({ name: "Ed25519" }, await edKey(publicHex, null, "verify"), fromBase64Url(sig), enc.encode(REPORT_PREFIX + body)))) return null;
    const t = JSON.parse(new TextDecoder().decode(fromBase64Url(body))) as { c?: unknown; exp?: unknown; p?: unknown };
    if (t.p !== "reel-report" || typeof t.exp !== "number" || t.exp * 1000 <= now.getTime() || !Array.isArray(t.c)) return null;
    return t.c.filter((c): c is string => typeof c === "string" && CODE.test(c));
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

/**
 * What a player's upload holds: "upload" is the whole film (the full reel: the score and the numbers when the engine is
 * sure, `NO_SCORE_WHY`), and "clips" is the phone's own cut of the best points by sound (the fast reel: no score, no
 * numbers). The owner, 23 November 2026: both, the player's choice, and the full reel is the one to prefer. Since 27
 * November 2026 the reel's job makes both with no person (`fastReelStart`).
 */
export type SendWay = "upload" | "clips";

/** The organiser or a player with a place, in a match that has started and was not cancelled. */
async function senderOf(db: Db, eventId: string, playerId: string, now: Date, again = false) {
  const [ev] = await db.select({ id: events.id, code: events.code, type: events.type, status: events.status, startsAt: events.startsAt, creatorPlayerId: events.creatorPlayerId }).from(events).where(eq(events.id, eventId)).limit(1);
  if (!ev || ev.type !== "match") throw new DomainError("not_found");
  if (ev.status === "cancelled") throw new DomainError("cancelled");
  if (ev.startsAt.getTime() > now.getTime()) throw new DomainError("not_started");
  if (ev.creatorPlayerId !== playerId && !(await isSeated(db, ev.id, playerId))) throw new DomainError("forbidden");
  const [row] = await db.select().from(matchReels).where(eq(matchReels.eventId, ev.id)).limit(1);
  // A video that is here is not written over by a second player. A reel that plays is written over only on purpose:
  // a player of the match chose "Make a new reel" (`again`; the owner, 26 November 2026: "Erik will redo the reel").
  if (row && (row.status === "received" || row.status === "working" || (!again && reelView(row, now)))) throw new DomainError("locked");
  return { ev, row };
}

/**
 * "Who is who?": the upload whose names the reel's maker waits for, for a player of the match or its organiser. The
 * upload comes from the row's own note, never from the browser, so a ticket is only ever for the question this
 * match is asked. Null when the maker waits for nothing.
 */
export async function namesUpload(db: Db, input: { eventId: string; playerId: string }): Promise<{ upload: string; code: string } | null> {
  const [ev] = await db.select({ id: events.id, code: events.code, creatorPlayerId: events.creatorPlayerId }).from(events).where(eq(events.id, input.eventId)).limit(1);
  if (!ev) throw new DomainError("not_found");
  if (ev.creatorPlayerId !== input.playerId && !(await isSeated(db, ev.id, input.playerId))) throw new DomainError("forbidden");
  const [row] = await db.select({ status: matchReels.status, note: matchReels.note }).from(matchReels).where(eq(matchReels.eventId, ev.id)).limit(1);
  const names = row?.status === "working" ? progressOf(row.note)?.names : null;
  return names ? { upload: names.upload, code: ev.code } : null;
}

/**
 * "Choose the video": the token of this match's upload. A first call makes the row; a call while an
 * upload is not finished gives the same token, so any of the four players can go on with it.
 */
export async function askReelUpload(db: Db, input: { eventId: string; playerId: string; way?: SendWay; /** "Make a new reel": the reel that plays makes way. */ again?: boolean; now?: Date }): Promise<{ token: string; code: string }> {
  const now = input.now ?? new Date();
  const source = input.way === "clips" ? "clips" : "upload";
  const { ev, row } = await senderOf(db, input.eventId, input.playerId, now, input.again === true);
  // The same way again goes on with the same upload. The other way starts a new one: the parts of a whole
  // film and the parts of its clips are not one file.
  if (row?.status === "asked" && row.source === source) return { token: row.reelToken, code: ev.code };
  const values = { status: "asked" satisfies ReelStatus, source, sourceUrl: null, reelToken: newReelToken(), requestedBy: input.playerId, host: null, readyAt: null, note: null };
  await db.insert(matchReels).values({ eventId: ev.id, ...values }).onConflictDoUpdate({ target: matchReels.eventId, set: values });
  return { token: values.reelToken, code: ev.code };
}

/** "Paste a link": the match keeps the link to the film, and the video counts as here. */
export async function setReelLink(db: Db, input: { eventId: string; playerId: string; text: unknown; again?: boolean; now?: Date }): Promise<{ code: string }> {
  const now = input.now ?? new Date();
  const url = videoLinkOf(input.text);
  if (!url) throw new DomainError("invalid", "link");
  const { ev } = await senderOf(db, input.eventId, input.playerId, now, input.again === true);
  const values = { status: "received" satisfies ReelStatus, source: "link", sourceUrl: url, reelToken: newReelToken(), requestedBy: input.playerId, host: null, readyAt: null, note: null };
  await db.insert(matchReels).values({ eventId: ev.id, ...values }).onConflictDoUpdate({ target: matchReels.eventId, set: values });
  return { code: ev.code };
}

/**
 * The reel host says "the film of this upload is joined": the row goes from asked to received. Answers
 * the match's code and the way when this call changed the row, and null when there was nothing to change (a second
 * call, or a token nobody asked for), so the caller tells the owner once.
 */
export async function reelUploadReceived(db: Db, token: string): Promise<{ code: string; way: SendWay } | null> {
  const changed = await db
    .update(matchReels)
    .set({ status: "received" satisfies ReelStatus })
    .where(and(eq(matchReels.reelToken, token), eq(matchReels.status, "asked"), inArray(matchReels.source, ["upload", "clips"])))
    .returning({ eventId: matchReels.eventId, source: matchReels.source });
  if (changed.length === 0) return null;
  const [ev] = await db.select({ code: events.code }).from(events).where(eq(events.id, changed[0].eventId)).limit(1);
  return ev ? { code: ev.code, way: changed[0].source === "clips" ? "clips" : "upload" } : null;
}

/**
 * The operator says "the reel of this match is on the store": the row is written as ready, or an older
 * row of the match is replaced. Refuses a match that has not started, a host that is not an https
 * address and a token of the wrong shape, each before any write. `noScore`: why a reel from the whole film has
 * no score (`NO_SCORE_WHY`), kept in the ready row's note; anything else keeps no note.
 */
export async function setMatchReel(db: Db, input: { code: string; host: unknown; token: unknown; noScore?: unknown; now?: Date }): Promise<{ eventId: string; replaced: boolean; first: boolean }> {
  const now = input.now ?? new Date();
  const host = reelHostOf(input.host);
  if (!host) throw new DomainError("invalid", "host");
  if (!isReelToken(input.token)) throw new DomainError("invalid", "token");
  const [ev] = await db.select({ id: events.id, startsAt: events.startsAt, status: events.status }).from(events).where(eq(events.code, input.code)).limit(1);
  if (!ev || ev.status === "cancelled") throw new DomainError("not_found");
  if (ev.startsAt.getTime() > now.getTime()) throw new DomainError("not_started");
  const [old] = await db.select({ id: matchReels.id, readyAt: matchReels.readyAt }).from(matchReels).where(eq(matchReels.eventId, ev.id)).limit(1);
  const why = noScoreWhyOf(input.noScore);
  const values = { status: "ready" satisfies ReelStatus, host, reelToken: input.token, readyAt: now, note: why ? JSON.stringify({ noScore: why }) : null };
  await db
    .insert(matchReels)
    .values({ eventId: ev.id, source: "operator", ...values })
    .onConflictDoUpdate({ target: matchReels.eventId, set: values });
  // `first`: the match never had a reel on its page. A new cut after a progress report keeps `readyAt`
  // of the last one, so the players hear of the reel once, not once for each cut (`notifyReelReady`).
  return { eventId: ev.id, replaced: Boolean(old), first: !old?.readyAt };
}

/**
 * The reel's maker says it could not make the reel (`scripts/highlights/modal/fastreel.py`, any step that fails). The
 * row goes to "failed": the page offers to send the video again with one plain line, and the bar no longer waits for
 * a reel that will not come (25 November 2026: the first real start failed, and the page waited for ever). A reel
 * that already plays is not taken off by a failed new try. Answers whether the row changed.
 */
export async function setReelFailed(db: Db, code: string): Promise<boolean> {
  const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.code, code)).limit(1);
  if (!ev) throw new DomainError("not_found");
  const done = await db
    .update(matchReels)
    .set({ status: "failed" satisfies ReelStatus, note: null })
    .where(and(eq(matchReels.eventId, ev.id), inArray(matchReels.status, ["received", "working"])))
    .returning({ id: matchReels.id });
  return done.length > 0;
}

/** The operator takes a reel off the match page. The files stay on the store until their days end. */
export async function removeMatchReel(db: Db, code: string): Promise<boolean> {
  const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.code, code)).limit(1);
  if (!ev) throw new DomainError("not_found");
  const gone = await db.delete(matchReels).where(eq(matchReels.eventId, ev.id)).returning({ id: matchReels.id });
  return gone.length > 0;
}

/**
 * The reel's maker reports where it is (the owner, 24 November 2026: "Show the minutes remaining estimate
 * and progress bar instead"): a share done, the minutes it still needs, and what it does now. The row goes
 * to "working", and a reel that was shown goes off the page until the maker sends the new one. The engine
 * (or the session that runs it) calls this through `/api/admin/match-reel`; this announces nothing.
 */
export async function setReelProgress(
  db: Db,
  input: { code: string; pct: unknown; minutesLeft: unknown; step?: unknown; /** "names": the maker waits for who is who. */ waiting?: unknown; host?: unknown; upload?: unknown; now?: Date },
): Promise<{ eventId: string }> {
  const now = input.now ?? new Date();
  const pct = Number(input.pct);
  const minutes = Number(input.minutesLeft);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100 || !Number.isFinite(minutes) || minutes < 0 || minutes > 24 * 60) throw new DomainError("invalid", "progress");
  const [ev] = await db.select({ id: events.id, startsAt: events.startsAt }).from(events).where(and(eq(events.code, input.code), ne(events.status, "cancelled"))).limit(1);
  if (!ev) throw new DomainError("not_found");
  const host = reelHostOf(input.host);
  const waiting = input.waiting === "names" && host && isReelToken(input.upload) ? { waiting: "names", host, upload: input.upload } : {};
  const note = JSON.stringify({ pct: Math.round(pct), readyBy: new Date(now.getTime() + minutes * 60_000).toISOString(), step: stepOf(input.step), ...waiting });
  const done = await db.update(matchReels).set({ status: "working" satisfies ReelStatus, note }).where(eq(matchReels.eventId, ev.id)).returning({ id: matchReels.id });
  if (done.length > 0) return { eventId: ev.id };
  // A second match in the same clips (the third set as a match of its own, 24 November 2026) has no row of its own
  // until its reel is ready: the first progress gives it one, so its page shows the bar too. A match that has not
  // started gets none: a reel cannot be of it.
  if (ev.startsAt.getTime() > now.getTime()) throw new DomainError("not_found", "no_reel");
  await db.insert(matchReels).values({ eventId: ev.id, status: "working", source: "clips", reelToken: newReelToken(), note }).onConflictDoUpdate({ target: matchReels.eventId, set: { status: "working", note } });
  return { eventId: ev.id };
}

/**
 * The card's background when nobody added a court photo (the owner, 24 November 2026: "if there is no court
 * photo, use a frame from the team vs team announcement as a placeholder for the match card background"):
 * the frame the reel's maker saves beside the reel as `versus.jpg`. `stillAt` is when the reel became ready,
 * for the card's version; `stillDataUrl` reads the picture, and answers null when the reel has none.
 */
export async function reelStillAt(db: Db, eventId: string, now = new Date()): Promise<Date | null> {
  const view = await matchReel(db, eventId, now);
  return view ? new Date(view.keptUntil.getTime() - REEL_KEEP_DAYS * 86_400_000) : null;
}

export async function reelStillDataUrl(db: Db, eventId: string, now = new Date(), fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const view = await matchReel(db, eventId, now);
  if (!view) return null;
  try {
    const res = await fetchImpl(view.wide.replace(/\/wide\.mp4$/, "/versus.jpg"), { signal: AbortSignal.timeout(5000) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length < 2_000_000 ? `data:${type.split(";")[0]};base64,${bytes.toString("base64")}` : null;
  } catch {
    return null;
  }
}
