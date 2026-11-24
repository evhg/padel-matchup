import { pickStretches, type Stretch } from "@/lib/reel/fastPlan";

/**
 * The fast reel's work on the phone: listen to the film, find the points, and cut their stretches out
 * of the file with no loss of quality. Browser only.
 *
 * The work is the Rally Finder's core (`public/lab/rally-finder.html`, generated into
 * `public/lab/rf-core.js`): the same code that the lab page runs and that the engine runs in Node. It is
 * loaded when a player chooses the fast reel, so no other visit of the match page pays for it. Nothing is
 * decoded or encoded but the sound: the cut is made of slices of the player's own file.
 */

type Track = { handler: string; sampleRate?: number; durationSec?: number; ascInfo?: { rate?: number } };
type Box = { type: string; start: number; size: number; hdr: number; truncated?: boolean };
type Envelope = { seconds: number };
type ReadState = { env: Envelope; read: Record<string, number>; path: string; force: string; tick: () => Promise<void>; cancelled: () => boolean; stopped: () => boolean };
type Core = {
  walkTop(file: Blob): Promise<Box[]>;
  readRange(file: Blob, start: number, end: number): Promise<Uint8Array>;
  parseMoov(bytes: Uint8Array): { tracks: Track[]; durationSec: number; createdSec?: number };
  trackKind(t: Track): "aac" | "pcm" | null;
  Envelope: new (sampleRate: number, seconds: number) => Envelope;
  readAac(file: Blob, t: Track, sampleRate: number, progress: (seconds: number) => void, c: ReadState): Promise<void>;
  readPcm(file: Blob, t: Track, progress: (seconds: number) => void, c: ReadState): Promise<void>;
  prepare(env: Envelope): unknown;
  DEFAULTS: Record<string, number>;
  pickHits(prep: unknown, params: Record<string, number>): { hits: { t: number; s: number }[] };
  groupRallies(hits: unknown, prep: unknown, env: Envelope, params: Record<string, number>): unknown[];
  planCut(rallies: unknown[], isMarked: () => boolean, target: number, opts: { hits: unknown; duration: number; most: number }): Stretch[];
  planReel(kind: string, o: { rallies: unknown[]; hits: unknown; env: Envelope; prep: unknown; duration: number; isMarked: () => boolean }): Stretch[];
  buildCut(file: Blob, movie: unknown, segs: Stretch[], ftyp: Uint8Array | null): Promise<{ blob: Blob; videoSec: number; segments: { startSec: number; endSec: number }[] }>;
};

/** Why the phone could not make the cut: the page says each in words and offers the full reel. */
export type FastFault = "unreadable" | "no_sound" | "no_rallies";
export class FastError extends Error {
  constructor(public readonly fault: FastFault) {
    super(fault);
  }
}

let loading: Promise<Core> | null = null;
function loadCore(): Promise<Core> {
  const have = (globalThis as { KicksmashRF?: Core }).KicksmashRF;
  if (have) return Promise.resolve(have);
  loading ??= new Promise<Core>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "/lab/rf-core.js";
    s.onload = () => {
      const core = (globalThis as { KicksmashRF?: Core }).KicksmashRF;
      if (core) resolve(core);
      else reject(new Error("the core did not load"));
    };
    s.onerror = () => {
      loading = null;
      reject(new Error("the core did not load"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * The cut of one film: the best points by the sound's own ranking first, then the points with the loudest
 * reaction after them, joined where they overlap (`pickStretches`). `onProgress` gets the seconds of
 * sound that are read and the seconds there are.
 */
/** Where each clip of the cut sits in the film, and when the film began: a reel lines a watch's heart rate up with them. */
export type FilmTimes = { clips: [number, number][]; recordedAt: string | null; recordedFrom: "film" | "file" };

/**
 * When the film began. The film's own clock first (its `mvhd` box), when it is a date after 2020 and not
 * in the future; else the file's last change less the film's length, which on a phone is about when the
 * recording stopped. Null when neither is a date. Pure.
 */
export function filmStart(createdSec: number | undefined, lastModified: number, durationSec: number, now = Date.now()): { at: string | null; from: "film" | "file" } {
  const sane = (ms: number) => Number.isFinite(ms) && ms > Date.UTC(2020, 0, 1) && ms < now + 86_400_000;
  if (createdSec && sane(createdSec * 1000)) return { at: new Date(createdSec * 1000).toISOString(), from: "film" };
  const guess = lastModified - durationSec * 1000;
  return { at: sane(guess) ? new Date(guess).toISOString() : null, from: "file" };
}

export async function fastCut(file: File, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<{ blob: Blob; clips: number; seconds: number; times: FilmTimes }> {
  const RF = await loadCore();
  let movie: { tracks: Track[]; durationSec: number; createdSec?: number };
  let ftyp: Uint8Array | null = null;
  try {
    const boxes = await RF.walkTop(file);
    const moov = boxes.find((b) => b.type === "moov");
    if (!moov || moov.truncated || moov.size > 400e6) throw new FastError("unreadable");
    movie = RF.parseMoov(await RF.readRange(file, moov.start, moov.start + moov.size));
    const f = boxes.find((b) => b.type === "ftyp");
    ftyp = f && f.size < 4096 ? await RF.readRange(file, f.start, f.start + f.size) : null;
  } catch (e) {
    throw e instanceof FastError ? e : new FastError("unreadable");
  }
  const sound = movie.tracks.filter((t) => t.handler === "soun").find((t) => RF.trackKind(t));
  if (!sound) throw new FastError("no_sound");
  const rate = Math.round(sound.sampleRate || sound.ascInfo?.rate || 48000);
  const seconds = sound.durationSec || movie.durationSec;
  const env = new RF.Envelope(rate, seconds);
  const c: ReadState = { env, read: { bytesRead: 0, reads: 0, decodeMs: 0, featureMs: 0 }, path: "", force: "", tick: () => new Promise((r) => setTimeout(r, 0)), cancelled: () => signal.aborted, stopped: () => false };
  const progress = (done: number) => onProgress(Math.min(done, seconds), seconds);
  try {
    if (RF.trackKind(sound) === "pcm") await RF.readPcm(file, sound, progress, c);
    else await RF.readAac(file, sound, rate, progress, c);
  } catch {
    throw new FastError("unreadable");
  }
  if (signal.aborted) throw new DOMException("stopped", "AbortError");
  const prep = RF.prepare(env);
  const { hits } = RF.pickHits(prep, RF.DEFAULTS);
  const rallies = RF.groupRallies(hits, prep, env, RF.DEFAULTS);
  const o = { rallies, hits, env, prep, duration: seconds, isMarked: () => false };
  const stretches = pickStretches([RF.planCut(rallies, () => false, 150, { hits, duration: seconds, most: 8 }), RF.planReel("celebrations", o)].map((list) => list.map((s) => ({ start: s.start, end: s.end }))));
  if (stretches.length === 0) throw new FastError("no_rallies");
  let cut: { blob: Blob; videoSec: number; segments: { startSec: number; endSec: number }[] };
  try {
    cut = await RF.buildCut(file, movie, stretches, ftyp);
  } catch {
    throw new FastError("unreadable");
  }
  const began = filmStart(movie.createdSec, file.lastModified, movie.durationSec || seconds);
  const times: FilmTimes = { clips: cut.segments.map((x) => [x.startSec, x.endSec]), recordedAt: began.at, recordedFrom: began.from };
  return { blob: cut.blob, clips: cut.segments.length, seconds: Math.round(cut.videoSec), times };
}
