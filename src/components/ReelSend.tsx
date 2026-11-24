"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { askReelUploadAction, setReelLinkAction } from "@/actions/reel";
import { errorLine } from "@/lib/errorLine";
import { FastError, fastCut } from "./reelFast";

/** One part of the film. The reel host takes 64 MB a part and 150 seconds a request; 32 MB is 26 s on a line of 10 Mbit/s. */
const PART = 32 * 1024 * 1024;
/** Parts on their way at one time. */
const LANES = 3;
/** A part that failed is sent again this many times, with a longer wait each time. */
const TRIES = 6;
/** The reel host's limit for one match video (`UPLOAD_MAX_BYTES`). */
const MAX_BYTES = 80 * 2 ** 30;

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gb = (bytes: number) => (bytes / 1e9).toFixed(bytes < 1e10 ? 2 : 1);

type Way = "upload" | "clips";
type Phase =
  | { at: "idle" }
  | { at: "reading"; done: number; total: number; secondsLeft: number | null }
  | { at: "cutting" }
  | { at: "sending"; done: number; total: number; secondsLeft: number | null }
  | { at: "joining" }
  | { at: "sent"; way: Way }
  | { at: "stopped" };

/**
 * "Did you film it? Make the reel." on the match page, for the match's own players and organiser. The
 * owner, 23 November 2026: two ways, the player's choice, and the page says with a mark at each line what
 * the fast way does not have.
 *
 *   Full reel   the whole film goes to the reel host in parts, or the player pastes a link to it on a drive.
 *   Fast reel   the phone finds the points by sound and cuts them out of the file (`fastCut`); only the cut goes up.
 *
 * Nothing of the film passes through Kicksmash. The parts that are already there are asked for first, so
 * an upload that stopped goes on where it was when the player chooses the same file again, on this phone
 * or another. The screen is kept on while the page works, where the browser can do that.
 */
export function ReelSend({ code, started, canUpload, failed }: { code: string; /** Somebody began an upload that is not finished. */ started: boolean; canUpload: boolean; failed: boolean }) {
  const t = useTranslations("reel");
  const tr = useTranslations();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [pending, start] = useTransition();
  const whole = useRef<HTMLInputElement>(null);
  const fast = useRef<HTMLInputElement>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);
  // An iPhone converts a film that is chosen from the photo library before the page gets it (WebKit keeps that
  // for video), and a film of 44 GB never comes out of that. From the Files app the page gets the file as it is.
  const [iphone, setIphone] = useState(false);
  useEffect(() => setIphone(/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes("Mac") && navigator.maxTouchPoints > 1)), []);

  /** Sends one file or one cut to the reel host in parts, under this match's upload of that way. */
  const upload = async (body: Blob, name: string, way: Way, ctl: AbortController): Promise<"sent" | "locked" | { error: string }> => {
    setPhase({ at: "sending", done: 0, total: body.size, secondsLeft: null });
    const asked = await askReelUploadAction(code, way);
    if (!asked.ok) {
      if (asked.error === "locked") return "locked";
      return { error: asked.detail === "upload_off" ? t("uploadOff") : tr(`errors.${errorLine(asked.error)}`) };
    }
    const { url, token, ticket } = asked.data;
    const base = `${url}/u/${token}`;
    const auth = { Authorization: `Bearer ${ticket}` };
    const count = Math.ceil(body.size / PART);
    const sizeOf = (i: number) => Math.min(PART, body.size - i * PART);
    const there = (await fetch(base, { headers: auth, signal: ctl.signal }).then((r) => (r.ok ? r.json() : { parts: {} }))) as { parts?: Record<string, number>; done?: boolean };
    const todo: number[] = [];
    let done = 0;
    for (let i = 0; i < count; i++) {
      if (there.parts?.[String(i)] === sizeOf(i)) done += sizeOf(i);
      else todo.push(i);
    }
    const began = Date.now();
    let sentNow = 0;
    const show = () => {
      const elapsed = (Date.now() - began) / 1000;
      const rate = elapsed > 3 ? sentNow / elapsed : 0;
      setPhase({ at: "sending", done, total: body.size, secondsLeft: rate > 0 ? Math.round((body.size - done) / rate) : null });
    };
    show();
    const lane = async () => {
      for (;;) {
        const i = todo.shift();
        if (i === undefined) return;
        for (let n = 1; ; n++) {
          try {
            const r = await fetch(`${base}/${i}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: body.slice(i * PART, i * PART + sizeOf(i)), signal: ctl.signal });
            if (r.ok) break;
            // 401: the ticket is past its time. 409: the film is already joined. 413: too large. No second try helps.
            if (r.status === 401 || r.status === 409 || r.status === 413) throw new Error(`refused ${r.status}`);
            throw new TypeError(`status ${r.status}`);
          } catch (e) {
            if (ctl.signal.aborted || n >= TRIES || (e instanceof Error && e.message.startsWith("refused"))) throw e;
            await wait(1000 * 2 ** (n - 1));
          }
        }
        done += sizeOf(i);
        sentNow += sizeOf(i);
        show();
      }
    };
    if (!there.done) await Promise.all(Array.from({ length: Math.min(LANES, todo.length || 1) }, lane));
    setPhase({ at: "joining" });
    const fin = await fetch(`${base}/finish`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ parts: count, bytes: body.size, name }), signal: ctl.signal });
    if (!fin.ok) throw new Error(`finish ${fin.status}`);
    return "sent";
  };

  /** One run of either way: the screen stays on, a fault is said in words, and a page that went away says nothing. */
  const run = async (file: File, way: Way) => {
    setError(null);
    if (file.size === 0) return;
    if (way === "upload" && file.size > MAX_BYTES) return setError(t("tooLarge"));
    const ctl = new AbortController();
    stop.current = ctl;
    let lock: { release: () => Promise<void> } | null = null;
    try {
      lock = (await (navigator as Navigator & { wakeLock?: { request: (kind: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen")) ?? null;
    } catch {
      lock = null;
    }
    try {
      let body: Blob = file;
      let name = file.name;
      if (way === "clips") {
        setPhase({ at: "reading", done: 0, total: 0, secondsLeft: null });
        // Time left from the speed so far (Erik, 24 November 2026: "there was no time estimate", and he
        // stopped a 90-minute film at 5% not knowing whether it would take ten minutes or an hour).
        const began = Date.now();
        const cut = await fastCut(
          file,
          (done, total) => {
            const elapsed = (Date.now() - began) / 1000;
            const rate = elapsed > 5 && done > 0 ? done / elapsed : 0;
            setPhase({ at: "reading", done, total, secondsLeft: rate > 0 ? Math.round((total - done) / rate) : null });
          },
          ctl.signal,
        );
        setPhase({ at: "cutting" });
        body = cut.blob;
        name = `${file.name.replace(/\.[^.]*$/, "")}-clips.mp4`;
      }
      const res = await upload(body, name, way, ctl);
      if (res === "locked") {
        // Another player's video arrived first: the page says so after a refresh.
        setPhase({ at: "idle" });
        return router.refresh();
      }
      if (res !== "sent") {
        setPhase({ at: "idle" });
        return setError(res.error);
      }
      setPhase({ at: "sent", way });
      router.refresh();
    } catch (e) {
      // One lane gave up: the others stop too. A page that went away aborted first, and has nothing to show.
      const left = ctl.signal.aborted;
      ctl.abort();
      if (left) return;
      if (e instanceof FastError) {
        setPhase({ at: "idle" });
        return setError(t(e.fault === "no_rallies" ? "fastNone" : e.fault === "no_sound" ? "fastNoSound" : "fastBad"));
      }
      setPhase({ at: "stopped" });
    } finally {
      await lock?.release().catch(() => undefined);
      if (whole.current) whole.current.value = "";
      if (fast.current) fast.current.value = "";
    }
  };

  const saveLink = () => {
    setError(null);
    start(async () => {
      const r = await setReelLinkAction(code, link);
      if (!r.ok) {
        if (r.error === "locked") return router.refresh();
        return setError(r.error === "invalid" ? t("linkBad") : tr(`errors.${errorLine(r.error)}`));
      }
      setLink("");
      router.refresh();
    });
  };

  if (phase.at === "sent")
    return (
      <section className="card" data-testid="reel-here">
        <h2 className="text-lg font-extrabold">{t("hereTitle")}</h2>
        <p className="mt-1 text-sm text-muted">{t(phase.way === "clips" ? "hereClipsBody" : "hereBody")}</p>
      </section>
    );

  const busy = phase.at === "reading" || phase.at === "cutting" || phase.at === "sending" || phase.at === "joining";
  const pct =
    phase.at === "sending" && phase.total > 0 ? Math.floor((phase.done / phase.total) * 100) : phase.at === "reading" && phase.total > 0 ? Math.floor((phase.done / phase.total) * 100) : phase.at === "joining" || phase.at === "cutting" ? 100 : 0;
  const left = (secondsLeft: number | null) => (secondsLeft === null ? ` · ${t("measuring")}` : ` · ${secondsLeft < 60 ? t("underMinute") : t("minutesLeft", { min: Math.ceil(secondsLeft / 60) })}`);
  const line =
    phase.at === "reading"
      ? `${t("reading", { done: Math.floor(phase.done / 60), total: Math.ceil(phase.total / 60) })}${left(phase.secondsLeft)}`
      : phase.at === "cutting"
        ? t("cutting")
        : phase.at === "joining"
          ? t("joining")
          : phase.at === "sending"
            ? `${t("progress", { done: gb(phase.done), total: gb(phase.total) })}${left(phase.secondsLeft)}`
            : "";
  const mark = (has: boolean, text: string) => (
    <li className={`flex items-start gap-2 ${has ? "" : "text-muted"}`}>
      <span aria-hidden="true" className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-xs font-extrabold ${has ? "bg-ok-soft text-ok" : "border border-danger text-danger"}`}>
        {has ? "✓" : "✕"}
      </span>
      <span>
        <span className="sr-only">{t(has ? "has" : "hasNot")} </span>
        {text}
      </span>
    </li>
  );

  return (
    <section className="card" data-testid="reel-send">
      <h2 className="text-lg font-extrabold">{t("sendTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{failed ? t("failedLine") : started && phase.at === "idle" ? t("startedLine") : t(canUpload ? "chooseWay" : "sendBody")}</p>
      {busy && (
        <div className="mt-3" data-testid="reel-progress">
          <div className="h-3 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div className="h-full rounded-full bg-accent-deep transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-sm font-semibold">{line}</p>
          <p className="mt-1 text-xs text-faint">{t("keepOpen")}</p>
        </div>
      )}
      {phase.at === "stopped" && <p className="mt-2 text-sm font-semibold text-danger">{t("stopped")}</p>}
      {error && (
        <p className="mt-2 text-sm font-semibold text-danger" data-testid="reel-error">
          {error}
        </p>
      )}
      {!busy && iphone && canUpload && (
        <p className="mt-3 rounded-2xl bg-warn-soft px-3 py-2 text-xs text-ink" data-testid="reel-iphone-hint">
          {t("iphoneHint")}
        </p>
      )}
      {!busy && (
        <div className="mt-3 flex flex-col gap-3">
          {/* The full reel: first, and with the mark, because it is the one to prefer. */}
          <div className="rounded-2xl border-2 border-ink p-4" data-testid="reel-way-full">
            <h3 className="flex flex-wrap items-center gap-2 font-extrabold">
              {t("fullTitle")} <span className="chip-live">{t("best")}</span>
            </h3>
            <p className="mt-1 text-xs text-muted">{t("fullSub")}</p>
            <ul className="mt-3 flex flex-col gap-1.5 text-sm">
              {mark(true, t("has1"))}
              {mark(true, t("has2"))}
              {mark(true, t("has3"))}
              {mark(true, t("has4"))}
            </ul>
            {canUpload && (
              <>
                <input ref={whole} type="file" accept="video/*" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="reel-file" onChange={(e) => e.target.files?.[0] && void run(e.target.files[0], "upload")} />
                {/* Dark, not lime: after a match the page's one lime button is the score's or "Play again" (the owner, 9 November 2026). */}
                <button type="button" className="btn-secondary mt-3 w-full" onClick={() => whole.current?.click()} data-testid="reel-choose">
                  {started || phase.at === "stopped" ? t("chooseAgain") : t("choose")}
                </button>
                <p className="mt-2 text-xs text-faint">{t("kept7")}</p>
              </>
            )}
            <details className="mt-2 text-sm" open={!canUpload} data-testid="reel-link">
              <summary className="cursor-pointer font-semibold text-muted">{t(canUpload ? "linkSummary" : "linkOnly")}</summary>
              <div className="mt-2 flex flex-col gap-2">
                <p className="text-xs text-faint">{t("linkHelp")}</p>
                <input className="input" inputMode="url" autoComplete="off" placeholder="https://www.icloud.com/…" aria-label={t("linkLabel")} value={link} onChange={(e) => setLink(e.target.value)} data-testid="reel-link-input" />
                <button type="button" className="btn-ghost" disabled={pending || !link.trim()} onClick={saveLink} data-testid="reel-link-save">
                  {pending ? "…" : t("linkSave")}
                </button>
              </div>
            </details>
          </div>
          {/* The fast reel: for a player with no time to send the whole film. The crosses say what it gives up. */}
          {canUpload && (
            <div className="rounded-2xl border border-line-strong p-4" data-testid="reel-way-fast">
              <h3 className="font-extrabold">{t("fastTitle")}</h3>
              <p className="mt-1 text-xs text-muted">{t("fastSub")}</p>
              <ul className="mt-3 flex flex-col gap-1.5 text-sm">
                {mark(true, t("fastHas1"))}
                {mark(true, t("fastHas2"))}
                {mark(false, t("fastNo1"))}
                {mark(false, t("fastNo2"))}
                {mark(false, t("fastNo3"))}
              </ul>
              <input ref={fast} type="file" accept="video/*" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="reel-fast-file" onChange={(e) => e.target.files?.[0] && void run(e.target.files[0], "clips")} />
              <button type="button" className="btn-ghost mt-3 w-full" onClick={() => fast.current?.click()} data-testid="reel-fast">
                {t("fastCta")}
              </button>
              <p className="mt-2 text-xs text-faint">{t("fastNote")}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
