"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { commercialLabel, formRules, initialForm, notAllowedYet, notReady, PRIVATE, STATUS_EVERY_MS, STATUS_STOP_MS, TITLE_MAX, type Creator, type PostForm, type TikTokError } from "@/lib/domain/tiktok";

const MUSIC_URL = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const BRANDED_URL = "https://www.tiktok.com/legal/page/global/bc-policy/en";

type Phase = { at: "form" } | { at: "sending" } | { at: "status"; publishId: string; state: "working" | "done" | "failed" | "stopped"; reason?: string };

/** A link to one of TikTok's two legal pages, from TikTok's own sentence above Post. */
function Legal({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="link">
      {children}
    </a>
  );
}

/** m:ss, for the longest video an account may post. */
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

/**
 * The form of the posting page, by TikTok's Content Sharing Guidelines: the creator's own account at the top,
 * the reel's preview, an editable title, the privacy with no default and only the account's options, Comment,
 * Duet and Stitch off (and locked where the account turns them off), the commercial content disclosure off,
 * TikTok's legal line above Post, and nothing sent before Post. After Post it says that processing takes a few
 * minutes and shows TikTok's status, asked every 5 seconds at most. The rules are `src/lib/domain/tiktok.ts`.
 */
export function TikTokPost({ code, creator, video, poster, title }: { code: string; creator: Creator; video: string; poster: string; title: string }) {
  const t = useTranslations("tiktok");
  const [form, setForm] = useState<PostForm>(() => initialForm(title));
  const [duration, setDuration] = useState<number | null>(null);
  const [phase, setPhase] = useState<Phase>({ at: "form" });
  const [error, setError] = useState<{ error: TikTokError; reconnect: boolean } | null>(null);
  const started = useRef(0);
  const rules = formRules(creator, form);
  const why = notReady(creator, form, duration);
  const label = commercialLabel(form);
  const set = (patch: Partial<PostForm>) => setForm((f) => ({ ...f, ...patch }));
  // A refusal in one line: an account TikTok does not let in yet, and a reel with no public version, in our words;
  // anything else in TikTok's own words.
  const refusalLine = (e: TikTokError) =>
    notAllowedYet(e.code) ? t("inTest") : e.code === "old_reel" ? t("oldReel") : e.code === "reel_unavailable" ? t("reelDown") : t("refused", { message: e.message || e.code });
  // Each privacy level TikTok knows in words; a level TikTok adds later shows TikTok's own word.
  const privacyName = (o: string) =>
    o === "PUBLIC_TO_EVERYONE" ? t("privacyEveryone") : o === "MUTUAL_FOLLOW_FRIENDS" ? t("privacyFriends") : o === "FOLLOWER_OF_CREATOR" ? t("privacyFollowers") : o === PRIVATE ? t("privacyOnlyMe") : o;

  // The status, every 5 seconds at most, until TikTok says done or failed, or for 15 minutes.
  const publishId = phase.at === "status" ? phase.publishId : null;
  const working = phase.at === "status" && phase.state === "working";
  useEffect(() => {
    if (!publishId || !working) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      if (Date.now() - started.current > STATUS_STOP_MS) return setPhase({ at: "status", publishId, state: "stopped" });
      const got = await fetch("/api/tiktok/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ publishId }) })
        .then((r) => r.json() as Promise<{ ok: boolean; status?: { state: "working" | "done" | "failed"; reason?: string } }>)
        .catch(() => null);
      if (stop) return;
      if (got?.ok && got.status && got.status.state !== "working") return setPhase({ at: "status", publishId, state: got.status.state, reason: got.status.reason });
      timer = setTimeout(tick, STATUS_EVERY_MS);
    };
    let timer = setTimeout(tick, STATUS_EVERY_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [publishId, working]);

  const post = async () => {
    if (why || phase.at !== "form") return;
    setError(null);
    setPhase({ at: "sending" });
    const got = await fetch("/api/tiktok/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code, ...form, durationSec: duration }) })
      .then((r) => r.json() as Promise<{ ok: boolean; publishId?: string; error?: TikTokError; reconnect?: boolean }>)
      .catch(() => null);
    if (got?.ok && got.publishId) {
      started.current = Date.now();
      return setPhase({ at: "status", publishId: got.publishId, state: "working" });
    }
    setError({ error: got?.error ?? { code: "network", message: "" }, reconnect: Boolean(got?.reconnect) });
    setPhase({ at: "form" });
  };

  const row = "flex min-h-11 items-center justify-between gap-3 py-2";
  const toggle = (on: boolean, text: string, flip: () => void, id: string, disabled = false) => (
    <div className={row}>
      <span className={disabled ? "text-faint" : ""}>{text}</span>
      <button type="button" role="switch" aria-checked={on} aria-label={text} disabled={disabled} onClick={flip} data-testid={id} className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition disabled:opacity-40 ${on ? "bg-ink" : "bg-line-strong"}`}>
        <span className={`inline-block h-5 w-5 rounded-full shadow transition ${on ? "translate-x-6 bg-on-ink" : "translate-x-1 bg-knob-off"}`} />
      </button>
    </div>
  );

  const account = (
    <section className="card flex items-center gap-3" data-testid="tiktok-account">
      {/* eslint-disable-next-line @next/next/no-img-element -- the creator's avatar on TikTok's own server, as TikTok gives it */}
      {creator.avatarUrl ? <img src={creator.avatarUrl} alt="" className="h-11 w-11 shrink-0 rounded-full bg-fill object-cover" /> : <span className="h-11 w-11 shrink-0 rounded-full bg-fill" />}
      <div className="min-w-0 flex-1">
        <p className="text-[0.9375rem] text-muted">{t("postingAs")}</p>
        <p className="truncate font-bold" data-testid="tiktok-nickname">
          {creator.nickname || creator.username}
        </p>
        {creator.username && <p className="truncate text-[0.9375rem] text-muted">{`@${creator.username}`}</p>}
        {phase.at === "form" && (
          <a href={`/api/tiktok/start?code=${code}&again=1`} className="link inline-flex min-h-11 items-center text-[0.9375rem] font-semibold">
            {t("otherAccount")}
          </a>
        )}
      </div>
    </section>
  );
  const preview = <video className="mx-auto block aspect-[9/16] max-h-[60vh] max-w-full rounded-2xl bg-night object-cover" controls playsInline preload="metadata" poster={poster} src={video} onLoadedMetadata={(e) => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)} data-testid="tiktok-preview" />;

  if (phase.at === "status") {
    const line = phase.state === "done" ? t("statusDone") : phase.state === "failed" ? (notAllowedYet(phase.reason) ? t("inTest") : t("statusFailed", { reason: phase.reason ?? "" })) : phase.state === "stopped" ? t("statusStopped") : t("statusWorking");
    return (
      <>
        {account}
        <section className="card" aria-live="polite" data-testid="tiktok-status" data-state={phase.state}>
          <p className={`font-semibold ${phase.state === "failed" ? "text-danger" : phase.state === "done" ? "text-ok" : ""}`}>{line}</p>
          <p className="mt-1 text-[0.9375rem] text-muted">{t("processing")}</p>
        </section>
      </>
    );
  }

  return (
    <>
      {account}
      {preview}
      <section className="card flex flex-col gap-4">
        <div>
          <label className="label" htmlFor="tiktok-title">
            {t("titleLabel")}
          </label>
          <textarea id="tiktok-title" className="textarea" maxLength={TITLE_MAX} value={form.title} onChange={(e) => set({ title: e.target.value })} data-testid="tiktok-title" />
        </div>
        <div>
          <label className="label" htmlFor="tiktok-privacy">
            {t("privacyLabel")}
          </label>
          <select id="tiktok-privacy" className="input" value={form.privacy} onChange={(e) => set({ privacy: e.target.value })} data-testid="tiktok-privacy">
            <option value="" disabled>
              {t("privacyPick")}
            </option>
            {rules.privacyOptions.map((o) => (
              <option key={o} value={o} disabled={o === PRIVATE && rules.privateDisabled}>
                {privacyName(o)}
              </option>
            ))}
          </select>
          {rules.privateDisabled && rules.privacyOptions.includes(PRIVATE) && <p className="mt-1.5 px-1 text-xs text-faint">{t("brandedNotPrivate")}</p>}
        </div>
      </section>
      <section className="card">
        <p className="label">{t("allowLabel")}</p>
        <div className="divide-y divide-line">
          {toggle(form.allowComment && !rules.comment.disabled, t("comment"), () => set({ allowComment: !form.allowComment }), "tiktok-comment", rules.comment.disabled)}
          {toggle(form.allowDuet && !rules.duet.disabled, t("duet"), () => set({ allowDuet: !form.allowDuet }), "tiktok-duet", rules.duet.disabled)}
          {toggle(form.allowStitch && !rules.stitch.disabled, t("stitch"), () => set({ allowStitch: !form.allowStitch }), "tiktok-stitch", rules.stitch.disabled)}
        </div>
      </section>
      <section className="card" data-testid="tiktok-commercial">
        {toggle(form.commercial, t("commercial"), () => set({ commercial: !form.commercial, yourBrand: false, branded: false }), "tiktok-commercial-switch")}
        {form.commercial && (
          <div className="mt-1 divide-y divide-line border-t border-line">
            <label className={row}>
              <span>{t("yourBrand")}</span>
              <input type="checkbox" className="h-5 w-5 accent-court" checked={form.yourBrand} onChange={(e) => set({ yourBrand: e.target.checked })} data-testid="tiktok-your-brand" />
            </label>
            <label className={row}>
              <span className={rules.brandedDisabled ? "text-faint" : ""}>
                {t("branded")}
                {rules.brandedDisabled && <span className="block text-xs">{t("brandedNotPrivate")}</span>}
              </span>
              <input type="checkbox" className="h-5 w-5 accent-court" checked={form.branded} disabled={rules.brandedDisabled} onChange={(e) => set({ branded: e.target.checked })} data-testid="tiktok-branded" />
            </label>
          </div>
        )}
        {label && (
          <p className="mt-2 px-1 text-xs text-faint" data-testid="tiktok-commercial-label">
            {label === "labelPaid" ? t("labelPaid") : label === "labelPromo" ? t("labelPromo") : t("commercialPick")}
          </p>
        )}
      </section>
      {why === "too_long" && (
        <p className="px-1 text-[0.9375rem] text-danger" data-testid="tiktok-too-long">
          {t("tooLong", { time: clock(creator.maxDurationSec) })}
        </p>
      )}
      <p className="px-1 text-xs text-faint" data-testid="tiktok-legal">
        {t("agreeLead")}{" "}
        {form.commercial && form.branded && (
          <>
            <Legal href={BRANDED_URL}>{t("brandedPolicy")}</Legal> {t("agreeAnd")}{" "}
          </>
        )}
        <Legal href={MUSIC_URL}>{t("musicPolicy")}</Legal>.
      </p>
      {error && (
        <p role="alert" className="px-1 text-[0.9375rem] text-danger" data-testid="tiktok-error" data-code={error.error.code}>
          {refusalLine(error.error)}
          {error.reconnect && (
            <>
              {" "}
              <a href={`/api/tiktok/start?code=${code}&again=1`} className="link">
                {t("reconnect")}
              </a>
            </>
          )}
        </p>
      )}
      <button type="button" className="btn-primary w-full" disabled={Boolean(why) || phase.at === "sending"} onClick={() => void post()} data-testid="tiktok-post">
        {phase.at === "sending" ? t("posting") : t("post")}
      </button>
    </>
  );
}
