"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { askReelUploadAction, setReelLinkAction } from "@/actions/reel";
import { errorLine } from "@/lib/errorLine";

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

type Phase = { at: "idle" } | { at: "sending"; done: number; total: number; secondsLeft: number | null } | { at: "joining" } | { at: "sent" } | { at: "stopped" };

/**
 * "Did you film it? Make the reel." on the match page, for the match's own players and organiser: the
 * player chooses the film and this page sends it to the reel host in parts, or the player pastes a link
 * to the film on a drive (the owner, 23 November 2026: both ways, the player's choice).
 *
 * Nothing of the film passes through Kicksmash. The parts that are already there are asked for first,
 * so an upload that stopped goes on where it was when the player chooses the same file again, on this
 * phone or another. The screen is kept on while it sends, where the browser can do that.
 */
export function ReelSend({ code, started, canUpload, failed }: { code: string; /** Somebody began an upload that is not finished. */ started: boolean; canUpload: boolean; failed: boolean }) {
  const t = useTranslations("reel");
  const tr = useTranslations();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ at: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState("");
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);

  const send = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) return setError(t("tooLarge"));
    if (file.size === 0) return;
    setPhase({ at: "sending", done: 0, total: file.size, secondsLeft: null });
    const asked = await askReelUploadAction(code);
    if (!asked.ok) {
      setPhase({ at: "idle" });
      // Another player's video arrived first: the page says so after a refresh.
      if (asked.error === "locked") return router.refresh();
      return setError(asked.detail === "upload_off" ? t("uploadOff") : tr(`errors.${errorLine(asked.error)}`));
    }
    const { url, token, ticket } = asked.data;
    const base = `${url}/u/${token}`;
    const auth = { Authorization: `Bearer ${ticket}` };
    const ctl = new AbortController();
    stop.current = ctl;
    let lock: { release: () => Promise<void> } | null = null;
    try {
      lock = (await (navigator as Navigator & { wakeLock?: { request: (kind: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock?.request("screen")) ?? null;
    } catch {
      lock = null;
    }
    try {
      const count = Math.ceil(file.size / PART);
      const sizeOf = (i: number) => Math.min(PART, file.size - i * PART);
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
        setPhase({ at: "sending", done, total: file.size, secondsLeft: rate > 0 ? Math.round((file.size - done) / rate) : null });
      };
      show();
      const lane = async () => {
        for (;;) {
          const i = todo.shift();
          if (i === undefined) return;
          for (let n = 1; ; n++) {
            try {
              const r = await fetch(`${base}/${i}`, { method: "PUT", headers: { ...auth, "Content-Type": "application/octet-stream" }, body: file.slice(i * PART, i * PART + sizeOf(i)), signal: ctl.signal });
              if (r.ok) break;
              // 401: the ticket is past its time. 409: the film is already joined. No second try helps either.
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
      const fin = await fetch(`${base}/finish`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ parts: count, bytes: file.size, name: file.name }), signal: ctl.signal });
      if (!fin.ok) throw new Error(`finish ${fin.status}`);
      setPhase({ at: "sent" });
      router.refresh();
    } catch {
      // One lane gave up: the others stop too. A page that went away aborted first, and has nothing to show.
      const left = ctl.signal.aborted;
      ctl.abort();
      if (!left) setPhase({ at: "stopped" });
    } finally {
      await lock?.release().catch(() => undefined);
      if (input.current) input.current.value = "";
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
        <p className="mt-1 text-sm text-muted">{t("hereBody")}</p>
      </section>
    );

  const busy = phase.at === "sending" || phase.at === "joining";
  const pct = phase.at === "sending" && phase.total > 0 ? Math.floor((phase.done / phase.total) * 100) : phase.at === "joining" ? 100 : 0;
  return (
    <section className="card" data-testid="reel-send">
      <h2 className="text-lg font-extrabold">{t("sendTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{failed ? t("failedLine") : started && phase.at === "idle" ? t("startedLine") : t("sendBody")}</p>
      {canUpload && (
        <>
          <input ref={input} type="file" accept="video/*" className="sr-only" tabIndex={-1} aria-hidden="true" data-testid="reel-file" onChange={(e) => e.target.files?.[0] && void send(e.target.files[0])} />
          {/* Dark, not lime: after a match the page's one lime button is the score's or "Play again" (the owner, 9 November 2026). */}
          {!busy && (
            <button type="button" className="btn-secondary mt-3 w-full" onClick={() => input.current?.click()} data-testid="reel-choose">
              {started || phase.at === "stopped" ? t("chooseAgain") : t("choose")}
            </button>
          )}
          {busy && (
            <div className="mt-3" data-testid="reel-progress">
              <div className="h-3 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className="h-full rounded-full bg-accent-deep transition-[width]" style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-2 text-sm font-semibold">
                {phase.at === "joining"
                  ? t("joining")
                  : phase.at === "sending"
                    ? `${t("progress", { done: gb(phase.done), total: gb(phase.total) })}${phase.secondsLeft === null ? "" : ` · ${phase.secondsLeft < 60 ? t("underMinute") : t("minutesLeft", { min: Math.ceil(phase.secondsLeft / 60) })}`}`
                    : ""}
              </p>
              <p className="mt-1 text-xs text-faint">{t("keepOpen")}</p>
            </div>
          )}
          {phase.at === "stopped" && <p className="mt-2 text-sm font-semibold text-danger">{t("stopped")}</p>}
          {!busy && <p className="mt-2 text-xs text-faint">{t("kept7")}</p>}
        </>
      )}
      {!busy && (
        <details className="mt-3 text-sm" open={!canUpload} data-testid="reel-link">
          <summary className="cursor-pointer font-semibold text-muted">{t(canUpload ? "linkSummary" : "linkOnly")}</summary>
          <div className="mt-2 flex flex-col gap-2">
            <p className="text-xs text-faint">{t("linkHelp")}</p>
            <input className="input" inputMode="url" autoComplete="off" placeholder="https://www.icloud.com/…" aria-label={t("linkLabel")} value={link} onChange={(e) => setLink(e.target.value)} data-testid="reel-link-input" />
            <button type="button" className="btn-ghost" disabled={pending || !link.trim()} onClick={saveLink} data-testid="reel-link-save">
              {pending ? "…" : t("linkSave")}
            </button>
          </div>
        </details>
      )}
      {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
    </section>
  );
}
