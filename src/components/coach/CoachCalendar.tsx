"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { checkCalendarAction, saveCalendarAction, type CalendarState } from "@/actions/coach";
import { HowThisWorks } from "./HowThisWorks";

type Props = {
  serviceEmail: string | null;
  initial: { gcalId: string; icalUrl: string; status: string | null; syncedAt: string | null; error: string | null };
};

/**
 * The coach's calendar, attached the way a colleague would be: share it with our address,
 * paste the calendar's own address, tap check. Apple and Outlook come in through a secret
 * iCal link, read-only. Two steps, one screen, and the status says what to do next.
 */
export function CoachCalendar({ serviceEmail, initial }: Props) {
  const t = useTranslations("coach.calendar");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [gcalId, setGcalId] = useState(initial.gcalId);
  const [icalUrl, setIcalUrl] = useState(initial.icalUrl);
  const [state, setState] = useState<CalendarState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showIcal, setShowIcal] = useState(Boolean(initial.icalUrl));

  const copy = async () => {
    if (!serviceEmail) return;
    try {
      await navigator.clipboard.writeText(serviceEmail);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* the address is on screen either way */
    }
  };

  const run = (fn: () => Promise<Awaited<ReturnType<typeof saveCalendarAction>>>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) {
        setError(r.error === "invalid" && r.detail === "ical" ? t("badLink") : t("badAddress"));
        return;
      }
      setState(r.data);
      router.refresh();
    });
  };

  const dirty = gcalId.trim() !== initial.gcalId || icalUrl.trim() !== initial.icalUrl;
  const attached = Boolean(initial.gcalId || initial.icalUrl);
  const gcal = state?.gcal;
  const ical = state?.ical;

  const statusLine = (() => {
    if (gcal) {
      if (gcal.ok) return { tone: "ok", text: t("linked", { name: gcal.summary }) };
      if (gcal.reason === "no_access" || gcal.reason === "not_found") return { tone: "warn", text: t("noAccess") };
      if (gcal.reason === "no_service_account") return { tone: "warn", text: t("unavailable") };
      return { tone: "warn", text: t("failed") };
    }
    if (ical) return ical.ok ? { tone: "ok", text: t("icalOk", { n: ical.busy }) } : { tone: "warn", text: t("icalFailed") };
    if (!attached) return null;
    if (initial.status === "linked" || (initial.icalUrl && !initial.error)) return { tone: "ok", text: initial.syncedAt ? t("syncedAt", { when: new Date(initial.syncedAt).toLocaleString(undefined, { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" }) }) : t("linkedShort") };
    if (initial.status === "no_access" || initial.status === "not_found") return { tone: "warn", text: t("noAccess") };
    if (initial.error) return { tone: "warn", text: initial.gcalId ? t("failed") : t("icalFailed") };
    return { tone: "muted", text: t("pending") };
  })();

  return (
    <section className="card flex flex-col gap-4" data-testid="coach-calendar">
      <div>
        <h2 className="text-xl font-extrabold tracking-tight">{t("title")}</h2>
        <p className="text-sm text-muted">{t("lead")}</p>
      </div>
      <ol className="flex flex-col gap-3 text-sm">
        <li>
          <div className="font-bold">{t("step1")}</div>
          <p className="text-xs text-muted">{t("step1Help")}</p>
          {serviceEmail ? (
            <div className="mt-1 flex items-center gap-2">
              <code className="truncate rounded bg-panel px-2 py-1 text-xs" data-testid="service-email">
                {serviceEmail}
              </code>
              <button type="button" className="text-xs font-bold text-ink underline underline-offset-4" onClick={copy}>
                {copied ? t("copied") : t("copy")}
              </button>
            </div>
          ) : (
            <p className="mt-1 text-xs text-danger">{t("unavailable")}</p>
          )}
        </li>
        <li>
          <label className="block font-bold" htmlFor="gcal-id">
            {t("step2")}
          </label>
          <p className="text-xs text-muted">{t("step2Help")}</p>
          <input id="gcal-id" className="input mt-1" value={gcalId} onChange={(e) => setGcalId(e.target.value)} inputMode="email" autoComplete="off" placeholder="name@gmail.com" maxLength={120} />
        </li>
      </ol>
      {showIcal ? (
        <label className="block text-sm font-bold" htmlFor="ical-url">
          {t("ical")}
          <p className="text-xs font-normal text-muted">{t("icalHelp")}</p>
          <input id="ical-url" className="input mt-1" value={icalUrl} onChange={(e) => setIcalUrl(e.target.value)} inputMode="url" autoComplete="off" placeholder="https://…/basic.ics" maxLength={500} />
        </label>
      ) : (
        <button type="button" className="self-start text-xs text-faint hover:text-muted" onClick={() => setShowIcal(true)}>
          {t("icalToggle")}
        </button>
      )}
      {statusLine && (
        <p className={`text-sm font-semibold ${statusLine.tone === "ok" ? "text-ok" : statusLine.tone === "warn" ? "text-danger" : "text-muted"}`} data-testid="calendar-status">
          {statusLine.text}
        </p>
      )}
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="button" className="btn-primary flex-1" disabled={pending || (!dirty && !attached) || (!gcalId.trim() && !icalUrl.trim() && !attached)} onClick={() => run(() => (dirty ? saveCalendarAction({ gcalId, icalUrl }) : checkCalendarAction()))}>
          {pending ? "…" : dirty ? t("attach") : t("check")}
        </button>
        {attached && (
          <button type="button" className="btn-ghost" disabled={pending} onClick={() => {
              setGcalId("");
              setIcalUrl("");
              run(() => saveCalendarAction({ gcalId: "", icalUrl: "" }));
            }}>
            {t("detach")}
          </button>
        )}
      </div>
      <HowThisWorks text={t("how")} />
    </section>
  );
}
