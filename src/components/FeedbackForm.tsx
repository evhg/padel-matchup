"use client";

import { useRef, useState, useTransition } from "react";
import { sendFeedbackAction } from "@/actions/feedback";
import type { FeedbackLabels } from "./feedbackLabels";

/**
 * A picture the phone makes small before it goes: a JPEG of 1280 px at most on its long side, at a
 * quality that keeps it under the server's limit (`FEEDBACK_SCREENSHOT_MAX`). Null when the browser
 * cannot read the file as a picture.
 */
async function shrink(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const q of [0.8, 0.65, 0.5, 0.35]) {
      const url = canvas.toDataURL("image/jpeg", q);
      if (url.length < 590_000) return url;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * One textarea, one optional email, one button. The thank-you says the note was read; a channel is named only when one exists, and nothing is promised.
 * The words come in `labels` (`feedbackLabels`), not from `useTranslations`: the form opens from the foot of every
 * screen, and a page hands the browser only the messages it names (`withClientMessages`), so fifty pages would each
 * have to name "feedback" for a button most visits never open.
 */
export function FeedbackForm({ signedInVia, labels }: { signedInVia: "telegram" | "none"; labels: FeedbackLabels }) {
  const t = (key: keyof FeedbackLabels) => labels[key];
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sent"; channel: string; reply: string; feedback: boolean } | { kind: "error"; msg: string }>({ kind: "idle" });
  const [pending, start] = useTransition();
  // A screenshot with the note (a player, 24 November 2026: "I cant send you a screenshot to help give feedback").
  const [shot, setShot] = useState<string | null>(null);
  const [shotBad, setShotBad] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  if (state.kind === "sent") {
    return (
      <section className="card">
        <h2 className="text-xl font-extrabold">{state.feedback ? "✅" : "💬"} {state.feedback ? t("sent") : t("notFeedback")}</h2>
        <p className="mt-2 text-sm text-ink-soft">{state.reply}</p>
        {state.feedback && state.channel === "telegram" && <p className="mt-2 text-sm text-muted">{t("viaTelegram")}</p>}
        {state.feedback && state.channel === "email" && <p className="mt-2 text-sm text-muted">{t("viaEmail")}</p>}
        {!state.feedback && (
          <button type="button" className="btn-secondary btn-sm mt-3" onClick={() => setState({ kind: "idle" })}>
            {t("tryAgain")}
          </button>
        )}
      </section>
    );
  }
  const submit = () => {
    if (text.trim().length < 3) {
      setState({ kind: "error", msg: t("tooShort") });
      return;
    }
    start(async () => {
      const here = typeof location === "undefined" ? "" : location.pathname;
      // On the page of its own, the form names the screen the person came from: the footer sends it as `from`, and a visit that began elsewhere on the site has it as the referrer.
      const from = here === "/feedback" ? new URLSearchParams(location.search).get("from") : null;
      const context = from?.startsWith("/") ? from : here === "/feedback" && typeof document !== "undefined" && document.referrer ? new URL(document.referrer).pathname : here || "/feedback";
      const r = await sendFeedbackAction(text, contact, context, shot);
      if (r.ok) {
        setState({ kind: "sent", channel: r.data.channel, reply: r.data.reply, feedback: r.data.kind === "feedback" });
        if (r.data.kind !== "feedback") setText("");
      }
      // "A few more words" is for a note that is too short, and the form checks that before it sends.
      else setState({ kind: "error", msg: r.error === "too_many" ? t("tooMany") : t("notSent") });
    });
  };
  return (
    <section className="card">
      <label className="block text-sm font-bold" htmlFor="feedback-text">
        {t("placeholder")}
      </label>
      <textarea id="feedback-text" className="input mt-2 w-full" rows={6} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} disabled={pending} placeholder={t("placeholder")} />
      {signedInVia === "telegram" ? (
        <p className="mt-3 text-xs text-muted">{t("viaTelegram")}</p>
      ) : (
        <>
          <label className="mt-3 block text-sm font-bold" htmlFor="feedback-contact">
            {t("contactLabel")}
          </label>
          <input id="feedback-contact" type="email" inputMode="email" autoComplete="email" className="input mt-2 w-full" value={contact} onChange={(e) => setContact(e.target.value)} disabled={pending} />
          <p className="mt-1 text-xs text-faint">{t("contactHelp")}</p>
        </>
      )}
      <input
        ref={picker}
        type="file"
        accept="image/*"
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        data-testid="feedback-shot-file"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const url = await shrink(f);
          setShotBad(!url);
          setShot(url);
        }}
      />
      {shot ? (
        <div className="mt-3 flex items-center gap-3 border-t border-line pt-3" data-testid="feedback-shot">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, never a remote picture */}
          <img src={shot} alt={t("shotAlt")} className="h-16 w-auto rounded-lg" />
          <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => setShot(null)}>
            {t("shotRemove")}
          </button>
        </div>
      ) : (
        <button type="button" className="btn-secondary btn-sm mt-3" disabled={pending} onClick={() => picker.current?.click()} data-testid="feedback-shot-add">
          {t("shotAdd")}
        </button>
      )}
      {shotBad && <p className="mt-1 text-xs text-danger">{t("shotBad")}</p>}
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="btn-primary" disabled={pending} onClick={submit}>
          {t("send")}
        </button>
        {state.kind === "error" && <span className="text-sm text-danger">{state.msg}</span>}
      </div>
    </section>
  );
}
