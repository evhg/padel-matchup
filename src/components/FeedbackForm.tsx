"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { sendFeedbackAction } from "@/actions/feedback";

/** One textarea, one optional email, one button. The thank-you says where the answer will arrive. */
export function FeedbackForm({ signedInVia }: { signedInVia: "telegram" | "none" }) {
  const t = useTranslations("feedback");
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "sent"; channel: string; reply: string; feedback: boolean } | { kind: "error"; msg: string }>({ kind: "idle" });
  const [pending, start] = useTransition();
  if (state.kind === "sent") {
    return (
      <section className="card">
        <h2 className="text-xl font-extrabold">{state.feedback ? "✅" : "💬"} {state.feedback ? t("sent") : t("notFeedback")}</h2>
        <p className="mt-2 text-sm text-ink-soft">{state.reply}</p>
        {state.feedback && state.channel === "telegram" && <p className="mt-2 text-sm text-muted">{t("viaTelegram")}</p>}
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
      const r = await sendFeedbackAction(text, contact, typeof location === "undefined" ? "" : document.referrer ? new URL(document.referrer).pathname : "/feedback");
      if (r.ok) {
        setState({ kind: "sent", channel: r.data.channel, reply: r.data.reply, feedback: r.data.kind === "feedback" });
        if (r.data.kind !== "feedback") setText("");
      }
      else setState({ kind: "error", msg: r.error === "too_many" ? t("tooMany") : t("tooShort") });
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
      <div className="mt-4 flex items-center gap-3">
        <button type="button" className="btn-primary" disabled={pending} onClick={submit}>
          {t("send")}
        </button>
        {state.kind === "error" && <span className="text-sm text-danger">{state.msg}</span>}
      </div>
    </section>
  );
}
