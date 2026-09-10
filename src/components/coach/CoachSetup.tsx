"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { saveCalendarAction, savePaymentAction, setupCoachAction, type CalendarState } from "@/actions/coach";
import { HowThisWorks } from "./HowThisWorks";

type Step = "where" | "length" | "hours" | "calendar" | "pay" | "bot";
type Day = { on: boolean; from: string; to: string };
const DEFAULT_DAYS: Day[] = Array.from({ length: 7 }, (_, d) => ({ on: d !== 0, from: "08:00", to: "20:00" }));
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * The assistant, set up as a short walk: where, how long, when (that makes it),
 * then the calendar, the payment and the Telegram bot, each one tap or "Later".
 * One question per screen; the coach is never asked to come back and finish.
 */
export function CoachSetup({ initialClubs = "", botUsername = null, botUrl = null, serviceEmail = null, existing = false }: { initialClubs?: string; botUsername?: string | null; /** The bot deep link with this coach's ticket, minted on the server so the button is live at once. */ botUrl?: string | null; serviceEmail?: string | null; /** The assistant already exists (the walk resumed after the third step): start at the calendar. */ existing?: boolean }) {
  const t = useTranslations("coach");
  const tCal = useTranslations("coach.calendar");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>(existing ? "calendar" : "where");
  const [clubs, setClubs] = useState(initialClubs);
  const [minutes, setMinutes] = useState<60 | 90>(60);
  const [days, setDays] = useState<Day[]>(DEFAULT_DAYS);
  const [badDay, setBadDay] = useState<number | null>(null);
  const [gcalId, setGcalId] = useState("");
  const [icalUrl, setIcalUrl] = useState("");
  const [showIcal, setShowIcal] = useState(!serviceEmail);
  const [calState, setCalState] = useState<CalendarState | null>(null);
  const [promptpay, setPromptpay] = useState("");
  const [payLink, setPayLink] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The calendar step stays without a Google service account: Apple and Outlook coaches attach an iCal address, which needs none.
  const steps: Step[] = ["where", "length", "hours", "calendar", "pay", ...(botUsername ? (["bot"] as Step[]) : [])];
  const index = steps.indexOf(step);
  const total = steps.length;
  const goNext = () => setStep(steps[Math.min(total - 1, index + 1)]);
  // A full navigation through /coach/done: the response sets the header's coach hint and opens the welcome.
  const finish = () => {
    window.location.assign("/coach/done");
  };
  const after = (s: Step) => (steps.indexOf(s) === total - 1 ? finish : goNext);

  const dayName = (d: number, style: "short" | "long" = "short") => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + d, 12)));
  const chip = (active: boolean) => `rounded-full border px-4 py-2 text-sm font-bold transition ${active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-ink/40"}`;
  const hoursLines = days.map((d) => (d.on ? `${d.from}-${d.to}` : "off"));

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBadDay(null);
    start(async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await setupCoachAction({ clubs, minutes, hoursLines, tz });
      if (!r.ok) {
        if (r.error === "invalid" && r.detail && /^\d$/.test(r.detail)) setBadDay(Number(r.detail));
        else setError(t("errors.no_coach"));
        return;
      }
      // From here the assistant exists: the page keeps this walk on screen under ?setup=1 while the next steps save.
      after("hours")();
      router.replace("/coach?setup=1", { scroll: false });
    });
  };

  const attach = () =>
    start(async () => {
      setError(null);
      const r = await saveCalendarAction({ gcalId, icalUrl });
      if (!r.ok) {
        setError(r.error === "invalid" && r.detail === "ical" ? tCal("badLink") : tCal("badAddress"));
        return;
      }
      setCalState(r.data);
    });

  const savePay = () =>
    start(async () => {
      setError(null);
      // Only what was typed is sent: a blank field here leaves a saved value alone.
      const r = await savePaymentAction({ promptpayId: promptpay.trim() || undefined, payLink: payLink.trim() || undefined });
      if (!r.ok) {
        setError(r.error === "invalid" && r.detail === "payLink" ? t("setup.badPayLink") : t("errors.no_coach"));
        return;
      }
      after("pay")();
    });

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
  const calLine = (() => {
    const g = calState?.gcal;
    const i = calState?.ical;
    if (g) return g.ok ? { ok: true, text: tCal("linked", { name: g.summary }) } : { ok: false, text: g.reason === "no_service_account" ? tCal("unavailable") : g.reason === "error" ? tCal("failed") : tCal("noAccess") };
    if (i) return i.ok ? { ok: true, text: tCal("icalOk", { n: i.busy }) } : { ok: false, text: tCal("icalFailed") };
    return null;
  })();

  return (
    <section className="card flex flex-col gap-5" data-testid={`setup-${step}`}>
      <div>
        <span className="chip-muted">🎾 {t("eyebrow")}</span>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("setup.title")}</h1>
        <p className="mt-1 text-xs font-bold uppercase tracking-wider text-faint">{t("setup.step", { n: index + 1, total })}</p>
      </div>

      {step === "where" && (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            goNext();
          }}
        >
          <div>
            <label className="text-sm font-bold" htmlFor="coach-clubs">
              {t("setup.club")}
            </label>
            <input id="coach-clubs" className="input mt-2" value={clubs} onChange={(e) => setClubs(e.target.value)} placeholder={t("setup.clubPlaceholder")} maxLength={120} autoFocus enterKeyHint="next" />
            <p className="mt-1 text-xs text-faint">{t("setup.clubHelp")}</p>
          </div>
          <button type="submit" className="btn-primary w-full">
            {t("setup.next")}
          </button>
          <HowThisWorks text={t("setup.how")} />
        </form>
      )}

      {step === "length" && (
        <div className="flex flex-col gap-4">
          <div>
            <div className="text-sm font-bold">{t("setup.length")}</div>
            <div className="mt-2 flex gap-2" role="radiogroup" aria-label={t("setup.length")}>
              {([60, 90] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={minutes === m} className={chip(minutes === m)} onClick={() => setMinutes(m)}>
                  {t("minutes", { n: m })}
                </button>
              ))}
            </div>
          </div>
          <button type="button" className="btn-primary w-full" onClick={goNext}>
            {t("setup.next")}
          </button>
        </div>
      )}

      {step === "hours" && (
        <form onSubmit={create} className="flex flex-col gap-4">
          <div>
            <div className="text-sm font-bold">{t("setup.hours")}</div>
            <p className="mt-1 text-xs text-faint">{t("setup.hoursHelp")}</p>
            <div className="mt-3 grid grid-cols-[4.5rem_1fr_auto_1fr] items-center gap-x-2 gap-y-2" data-testid="hours-grid">
              {ORDER.map((d) => {
                const day = days[d];
                const bad = badDay === d;
                return (
                  <div key={d} className="contents">
                    <button type="button" aria-pressed={day.on} aria-label={dayName(d, "long")} className={`${chip(day.on)} px-0 text-center`} onClick={() => setDays((ds) => ds.map((x, i) => (i === d ? { ...x, on: !x.on } : x)))}>
                      {dayName(d)}
                    </button>
                    <input type="time" className={`input px-2 ${bad ? "ring-2 ring-danger" : ""}`} value={day.from} disabled={!day.on} onChange={(e) => setDays((ds) => ds.map((x, i) => (i === d ? { ...x, from: e.target.value } : x)))} aria-label={`${dayName(d, "long")} ${t("setup.hours")}`} />
                    <span className="text-xs text-faint">–</span>
                    <input type="time" className={`input px-2 ${bad ? "ring-2 ring-danger" : ""}`} value={day.to} disabled={!day.on} onChange={(e) => setDays((ds) => ds.map((x, i) => (i === d ? { ...x, to: e.target.value } : x)))} />
                  </div>
                );
              })}
            </div>
            <button type="button" className="mt-2 text-xs font-bold text-muted underline underline-offset-4 hover:text-ink" onClick={() => setDays((ds) => ds.map((x, i) => (i === 1 ? x : { ...ds[1] })))}>
              {t("setup.sameAll")}
            </button>
          </div>
          {badDay !== null && <p className="text-sm font-semibold text-danger">{t("settings.invalidHours", { day: dayName(badDay, "long") })}</p>}
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <button type="submit" className="btn-primary w-full" disabled={pending}>
            {pending ? "…" : t("setup.create")}
          </button>
        </form>
      )}

      {step === "calendar" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm font-semibold text-ok">✓ {t("setup.created")}</p>
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">{t("setup.calendarTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("setup.calendarHelp")}</p>
          </div>
          {serviceEmail && (
          <ol className="flex flex-col gap-3 text-sm">
            <li>
              <div className="font-bold">{tCal("step1")}</div>
              <p className="text-xs text-muted">{tCal("step1Help")}</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="truncate rounded bg-panel px-2 py-1 text-xs" data-testid="service-email">
                  {serviceEmail}
                </code>
                <button type="button" className="text-xs font-bold text-ink underline underline-offset-4" onClick={copy}>
                  {copied ? tCal("copied") : tCal("copy")}
                </button>
              </div>
            </li>
            <li>
              <label className="block font-bold" htmlFor="setup-gcal">
                {tCal("step2")}
              </label>
              <p className="text-xs text-muted">{tCal("step2Help")}</p>
              <input id="setup-gcal" className="input mt-1" value={gcalId} onChange={(e) => setGcalId(e.target.value)} inputMode="email" autoComplete="off" placeholder="name@gmail.com" maxLength={120} />
            </li>
          </ol>
          )}
          {showIcal ? (
            <label className="block text-sm font-bold" htmlFor="setup-ical">
              {tCal("ical")}
              <input id="setup-ical" className="input mt-1" value={icalUrl} onChange={(e) => setIcalUrl(e.target.value)} inputMode="url" autoComplete="off" placeholder="https://…/basic.ics" maxLength={500} />
            </label>
          ) : (
            <button type="button" className="self-start text-xs text-faint hover:text-muted" onClick={() => setShowIcal(true)}>
              {tCal("icalToggle")}
            </button>
          )}
          {calLine && <p className={`text-sm font-semibold ${calLine.ok ? "text-ok" : "text-danger"}`}>{calLine.text}</p>}
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          {calLine?.ok ? (
            <button type="button" className="btn-primary w-full" onClick={after("calendar")}>
              {t("setup.next")}
            </button>
          ) : (
            <button type="button" className="btn-primary w-full" disabled={pending || (!gcalId.trim() && !icalUrl.trim())} onClick={attach}>
              {pending ? "…" : tCal("attach")}
            </button>
          )}
          <button type="button" className="btn-ghost w-full" onClick={after("calendar")}>
            {t("setup.later")}
          </button>
        </div>
      )}

      {step === "pay" && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">{t("setup.payTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("setup.payHelp")}</p>
          </div>
          <label className="block text-sm font-bold">
            {t("settings.promptpay")}
            <input className="input mt-1" value={promptpay} onChange={(e) => setPromptpay(e.target.value)} placeholder="08x xxx xxxx" inputMode="tel" autoComplete="off" maxLength={20} />
          </label>
          <label className="block text-sm font-bold">
            {t("settings.payLink")}
            <input className="input mt-1" value={payLink} onChange={(e) => setPayLink(e.target.value)} placeholder="https://" inputMode="url" autoComplete="off" maxLength={200} />
          </label>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <button type="button" className="btn-primary w-full" disabled={pending || (!promptpay.trim() && !payLink.trim())} onClick={savePay}>
            {pending ? "…" : t("setup.next")}
          </button>
          <button type="button" className="btn-ghost w-full" onClick={after("pay")}>
            {t("setup.later")}
          </button>
        </div>
      )}

      {step === "bot" && botUsername && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">{t("setup.botTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("setup.botHelp")}</p>
          </div>
          <a href={botUrl ?? `https://t.me/${botUsername}`} target="_blank" rel="noopener noreferrer" className="btn-primary w-full" data-testid="open-bot">
            {t("setup.botOpen", { bot: botUsername })}
          </a>
          <p className="text-xs text-faint">{t("setup.botAfter")}</p>
          <button type="button" className="btn-secondary w-full" onClick={finish} data-testid="setup-finish">
            {t("setup.finish")}
          </button>
        </div>
      )}
    </section>
  );
}
