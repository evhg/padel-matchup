"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { savePaymentAction, setupCoachAction } from "@/actions/coach";
import { ShareButtons } from "@/components/ShareSheet";
import { CoachNotify } from "./CoachNotify";
import { HowThisWorks } from "./HowThisWorks";
import { ImportSheet } from "./ImportSheet";
import { OffersEditor } from "./OffersEditor";
import { LESSON_MINUTES, type OfferInput } from "@/lib/domain/coaching";

type Step = "where" | "length" | "hours" | "price" | "notify" | "link";
type Day = { on: boolean; from: string; to: string };
type Preset = "mornings" | "afternoons" | "both";
export type ClubOption = { slug: string; name: string; city: string | null };

/** The same ranges the domain's presets use, so what the chips promise is what gets saved. */
const PRESET_HOURS: Record<Preset, string> = { mornings: "07:00-12:00", afternoons: "15:00-20:00", both: "07:00-12:00, 15:00-20:00" };
const DEFAULT_DAYS: Day[] = Array.from({ length: 7 }, (_, d) => ({ on: d !== 0, from: "07:00", to: "12:00" }));
const ORDER = [1, 2, 3, 4, 5, 6, 0];

/**
 * The assistant, set up as a short walk: where, how long, when (that makes it), what a lesson costs,
 * where to hear about bookings, and the link to hand a student.
 *
 * Three things changed from the first version, all of them because a coach who does not read
 * instructions has to end up with something that works:
 *
 * The hours were a grid pre-filled Monday to Saturday, eight in the morning to eight at night. A
 * coach who tapped through published seventy-two bookable hours a week and met the product by having
 * a student book their dinner. Presets come first now; the grid is behind "different each day".
 *
 * Google Calendar was the fourth screen, asking the coach to leave, walk a five-level menu and share
 * a calendar with a service account. That cannot be done in the Google Calendar phone apps at all, so
 * for most coaches it was not a hard step, it was an impossible one. It moved to the book, where it
 * can wait for a desk, and blocking an hour by tapping the grid does the job it was standing in for.
 *
 * And the walk used to end on a Done button while the link that makes any of this matter sat on a
 * screen the coach had not seen. It ends on the link now.
 */
export function CoachSetup({ initialClubs = "", clubOptions = [], botUsername = null, botUrl = null, existing = false, studentUrl = null, email = null, emailEnabled = false, vapidPublicKey = null, pushSubscribed = false }: { initialClubs?: string; /** Live clubs, for picking a real one instead of typing a name a club can never match. */ clubOptions?: ClubOption[]; botUsername?: string | null; /** The bot deep link with this coach's ticket, minted on the server so the button is live at once. */ botUrl?: string | null; /** The assistant already exists (the walk resumed after the third step): start at the price. */ existing?: boolean; /** The invite link to hand students, once the book exists. */ studentUrl?: string | null; /** The address already on file, for the channel step. */ email?: string | null; emailEnabled?: boolean; vapidPublicKey?: string | null; pushSubscribed?: boolean }) {
  const t = useTranslations("coach");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>(existing ? "price" : "where");
  const [clubs, setClubs] = useState(initialClubs);
  const [clubSlugs, setClubSlugs] = useState<string[]>([]);
  const [minutes, setMinutes] = useState<60 | 90>(60);
  const [preset, setPreset] = useState<Preset>("both");
  const [custom, setCustom] = useState(false);
  const [days, setDays] = useState<Day[]>(DEFAULT_DAYS);
  const [badDay, setBadDay] = useState<number | null>(null);
  // How close to the hour a student may still book. Personal, and asked here rather than found in
  // settings weeks later, after a 07:00 lesson was booked at 06:40.
  const [notice, setNotice] = useState<2 | 12 | 24>(2);
  const [price, setPrice] = useState("");
  // A coach who sells packages only leaves the price empty, which is what "no one-off lessons" means.
  // The switch is the same fact said out loud, so nobody has to work out what an empty field implies.
  const [adhoc, setAdhoc] = useState(true);
  const [groups, setGroups] = useState(false);
  const [priceTwo, setPriceTwo] = useState("");
  const [priceThree, setPriceThree] = useState("");
  const [priceFour, setPriceFour] = useState("");
  const [latePass, setLatePass] = useState(true);
  // Benji's card: a second length with its own prices, an extra outside the hours, and packages.
  // Each behind one line, shut by default, so a coach with one price still walks six short screens.
  const [second, setSecond] = useState(false);
  const [secondMinutes, setSecondMinutes] = useState<number>(90);
  const [priceSecondSingle, setPriceSecondSingle] = useState("");
  const [priceSecondTwo, setPriceSecondTwo] = useState("");
  const [feeOpen, setFeeOpen] = useState(false);
  const [fee, setFee] = useState("");
  const [offersOpen, setOffersOpen] = useState(false);
  const [offers, setOffers] = useState<OfferInput[]>([]);
  const [currency, setCurrency] = useState("THB");
  const [payAtClub, setPayAtClub] = useState(false);
  const [promptpay, setPromptpay] = useState("");
  const [payLink, setPayLink] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [link, setLink] = useState<string | null>(studentUrl);
  const [error, setError] = useState<string | null>(null);

  // The channel step is not conditional on the bot any more: turn Telegram off and a coach was never
  // asked at all. Email and push are offered on the same screen.
  const steps: Step[] = ["where", "length", "hours", "price", "notify", "link"];
  const index = steps.indexOf(step);
  const total = steps.length;
  const goNext = () => setStep(steps[Math.min(total - 1, index + 1)]);
  const finish = () => {
    window.location.assign("/coach/done");
  };

  const dayName = (d: number, style: "short" | "long" = "short") => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + d, 12)));
  const chip = (active: boolean) => `rounded-full border px-4 py-2 text-sm font-bold transition ${active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-ink/40"}`;
  // Custom: seven lines from the grid. Preset: the same range every day, which is what the chips say.
  const hoursLines = custom ? days.map((d) => (d.on ? `${d.from}-${d.to}` : "off")) : Array.from({ length: 7 }, () => PRESET_HOURS[preset]);

  const typed = clubs.trim().toLowerCase();
  const suggestions = typed.length < 2 ? [] : clubOptions.filter((c) => c.name.toLowerCase().includes(typed) && !clubSlugs.includes(c.slug)).slice(0, 6);
  const pickClub = (c: ClubOption) => {
    setClubs(c.name);
    setClubSlugs((s) => (s.includes(c.slug) ? s : [...s, c.slug]));
  };

  const create = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBadDay(null);
    start(async () => {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const r = await setupCoachAction({ clubs, clubSlugs, minutes, hoursLines, tz, minNoticeHours: notice });
      if (!r.ok) {
        if (r.error === "invalid" && r.detail && /^\d$/.test(r.detail)) setBadDay(Number(r.detail));
        else setError(t("errors.no_coach"));
        return;
      }
      setLink(r.data.studentUrl);
      goNext();
      // The book exists from here; the page keeps this walk on screen under ?setup=1 while the rest saves.
      router.replace("/coach?setup=1", { scroll: false });
    });
  };

  const savePay = () =>
    start(async () => {
      setError(null);
      const money = (v: string) => {
        const n = Number(v.replace(/[^\d]/g, ""));
        return v.trim() === "" || !Number.isFinite(n) ? null : n;
      };
      const secondLength = second && secondMinutes !== minutes ? secondMinutes : null;
      const r = await savePaymentAction({
        // The switch off clears every price: one-off lessons are not sold at any size.
        priceSingle: adhoc ? money(price) : null,
        priceTwo: adhoc && groups ? money(priceTwo) : null,
        priceThree: adhoc && groups ? money(priceThree) : null,
        priceFour: adhoc && groups ? money(priceFour) : null,
        secondMinutes: adhoc ? secondLength : null,
        priceSecondSingle: adhoc && secondLength ? money(priceSecondSingle) : null,
        priceSecondTwo: adhoc && secondLength ? money(priceSecondTwo) : null,
        outsideHoursFee: feeOpen ? money(fee) : null,
        offers: offersOpen ? offers.filter((o) => o.size > 0 && o.price > 0) : [],
        latePasses: latePass ? 1 : 0,
        currency,
        payAtClub,
        promptpayId: promptpay.trim() || undefined,
        payLink: payLink.trim() || undefined,
      });
      if (!r.ok) {
        setError(r.error === "invalid" && r.detail === "payLink" ? t("setup.badPayLink") : t("errors.no_coach"));
        return;
      }
      goNext();
    });

  return (
    <section className="card flex flex-col gap-5" data-testid={`setup-${step}`}>
      <div>
        <span className="chip-muted">🎾 {t("eyebrow")}</span>
        <h1 className="mt-3 text-3xl font-extrabold leading-tight tracking-tight">{t("setup.title")}</h1>
        <p className="mt-1 text-xs font-bold uppercase tracking-wider text-faint">{t("setup.step", { n: index + 1, total })}</p>
      </div>

      {step === "where" && (
        <form className="flex flex-col gap-4" onSubmit={(e) => (e.preventDefault(), goNext())}>
          <div>
            <label className="text-sm font-bold" htmlFor="coach-clubs">
              {t("setup.club")}
            </label>
            <input id="coach-clubs" className="input mt-2" value={clubs} onChange={(e) => setClubs(e.target.value)} placeholder={t("setup.clubPlaceholder")} maxLength={120} autoFocus enterKeyHint="next" autoComplete="off" />
            {suggestions.length > 0 && (
              <div className="mt-2 flex flex-col gap-1" data-testid="club-suggestions">
                {suggestions.map((c) => (
                  <button key={c.slug} type="button" className="rounded-lg border border-line px-3 py-2 text-left text-sm hover:border-ink/40" onClick={() => pickClub(c)}>
                    <span className="font-bold">{c.name}</span>
                    {c.city && <span className="text-faint"> · {c.city}</span>}
                  </button>
                ))}
              </div>
            )}
            <p className="mt-1 text-xs text-faint">{clubSlugs.length ? t("setup.clubPicked") : t("setup.clubHelp")}</p>
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
            <div className="mt-3 flex flex-wrap gap-2" role="radiogroup" aria-label={t("setup.hours")} data-testid="hours-presets">
              {(["mornings", "afternoons", "both"] as const).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={!custom && preset === p} className={chip(!custom && preset === p)} onClick={() => (setCustom(false), setPreset(p))} data-kind="preset" data-preset={p}>
                  {t(`setup.preset.${p}`)}
                </button>
              ))}
            </div>
            <button type="button" className="mt-3 text-xs font-bold text-muted underline underline-offset-4 hover:text-ink" onClick={() => setCustom((c) => !c)} data-testid="hours-custom">
              {custom ? t("setup.presetBack") : t("setup.custom")}
            </button>
            {custom && (
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
            )}
          </div>
          <div>
            <div className="text-sm font-bold">{t("setup.notice")}</div>
            <p className="mt-1 text-xs text-faint">{t("setup.noticeHelp")}</p>
            <div className="mt-2 flex gap-2" role="radiogroup" aria-label={t("setup.notice")} data-testid="notice-presets">
              {([2, 12, 24] as const).map((h) => (
                <button key={h} type="button" role="radio" aria-checked={notice === h} className={chip(notice === h)} onClick={() => setNotice(h)} data-notice={h}>
                  {t(`setup.notice${h}` as "setup.notice2")}
                </button>
              ))}
            </div>
          </div>
          {badDay !== null && <p className="text-sm font-semibold text-danger">{t("settings.invalidHours", { day: dayName(badDay, "long") })}</p>}
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <button type="submit" className="btn-primary w-full" disabled={pending}>
            {pending ? "…" : t("setup.create")}
          </button>
        </form>
      )}

      {step === "price" && (
        <div className="flex flex-col gap-4">
          <p className="text-sm font-semibold text-ok">✓ {t("setup.created")}</p>
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">{t("setup.priceTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("setup.priceHelp")}</p>
          </div>
          <label className="flex items-center gap-2 text-sm font-bold">
            <input type="checkbox" checked={adhoc} onChange={(e) => setAdhoc(e.target.checked)} data-testid="adhoc" />
            {t("setup.adhoc")}
          </label>
          {adhoc && (
            <>
              <div className="flex gap-2">
                <label className="block flex-1 text-sm font-bold">
                  {t("setup.priceLabel")}
                  <input className="input mt-1" value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="800" data-testid="price-single" />
                </label>
                <label className="block w-28 text-sm font-bold">
                  {t("setup.currency")}
                  <input className="input mt-1" value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} autoComplete="off" maxLength={3} />
                </label>
              </div>
              {/* Behind one line, shut by default: the walk is six taps and the shortness was won the hard way. */}
              {!groups ? (
                <button type="button" className="text-xs font-bold text-muted underline underline-offset-4 hover:text-ink self-start" onClick={() => setGroups(true)} data-testid="group-prices">
                  {t("setup.groupOpen")}
                </button>
              ) : (
                <div>
                  <p className="text-sm text-muted">{t("setup.groupHelp")}</p>
                  <div className="mt-2 flex gap-2">
                    <label className="block flex-1 text-sm font-bold">
                      {t("setup.priceTwo")}
                      <input className="input mt-1" value={priceTwo} onChange={(e) => setPriceTwo(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="500" data-testid="price-two" />
                    </label>
                    <label className="block flex-1 text-sm font-bold">
                      {t("setup.priceThree")}
                      <input className="input mt-1" value={priceThree} onChange={(e) => setPriceThree(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="400" data-testid="price-three" />
                    </label>
                    <label className="block flex-1 text-sm font-bold">
                      {t("setup.priceFour")}
                      <input className="input mt-1" value={priceFour} onChange={(e) => setPriceFour(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="350" data-testid="price-four" />
                    </label>
                  </div>
                  {/* A coach thinks in what the pair pays at the desk; the book keeps what each pays. Both on screen. */}
                  {Number(priceTwo.replace(/[^\d]/g, "")) > 0 && <p className="mt-1 text-xs text-muted">{t("setup.together", { amount: `${Number(priceTwo.replace(/[^\d]/g, "")) * 2} ${currency}`, n: 2 })}</p>}
                </div>
              )}
              {!second ? (
                <button type="button" className="text-xs font-bold text-muted underline underline-offset-4 hover:text-ink self-start" onClick={() => setSecond(true)} data-testid="second-open">
                  {t("setup.secondOpen")}
                </button>
              ) : (
                <div className="grid grid-cols-[7rem_1fr_1fr] gap-2" data-testid="second-length">
                  <label className="block text-xs font-bold text-muted">
                    {t("setup.secondLength")}
                    <select className="input mt-1" value={secondMinutes} onChange={(e) => setSecondMinutes(Number(e.target.value))} data-testid="second-minutes">
                      {LESSON_MINUTES.filter((m) => m !== minutes).map((m) => (
                        <option key={m} value={m}>
                          {t("minutes", { n: m })}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-xs font-bold text-muted">
                    {t("setup.secondSingle")}
                    <input className="input mt-1" value={priceSecondSingle} onChange={(e) => setPriceSecondSingle(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="1200" data-testid="price-second-single" />
                  </label>
                  <label className="block text-xs font-bold text-muted">
                    {t("setup.secondTwo")}
                    <input className="input mt-1" value={priceSecondTwo} onChange={(e) => setPriceSecondTwo(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="900" data-testid="price-second-two" />
                  </label>
                </div>
              )}
            </>
          )}
          {!feeOpen ? (
            <button type="button" className="text-xs font-bold text-muted underline underline-offset-4 hover:text-ink self-start" onClick={() => setFeeOpen(true)} data-testid="fee-open">
              {t("setup.feeOpen")}
            </button>
          ) : (
            <label className="block text-sm font-bold">
              {t("setup.feeLabel")} ({currency})
              <input className="input mt-1" value={fee} onChange={(e) => setFee(e.target.value)} inputMode="numeric" autoComplete="off" maxLength={9} placeholder="300" data-testid="fee" autoFocus />
              <span className="mt-1 block text-xs font-normal text-muted">{t("setup.feeHelp")}</span>
            </label>
          )}
          {!offersOpen ? (
            <button type="button" className="text-xs font-bold text-muted underline underline-offset-4 hover:text-ink self-start" onClick={() => (setOffersOpen(true), setOffers((o) => (o.length ? o : [{ size: 10, minutes, heads: 1, price: 0, validDays: 70 }])))} data-testid="offers-open">
              {t("setup.offersOpen")}
            </button>
          ) : (
            <div>
              <div className="text-sm font-bold">{t("page.packages")}</div>
              <p className="mt-1 text-xs text-muted">{t("setup.offersHelp")}</p>
              <div className="mt-2">
                <OffersEditor value={offers} onChange={setOffers} lengths={[minutes, ...(second && secondMinutes !== minutes ? [secondMinutes] : [])]} currency={currency} />
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={latePass} onChange={(e) => setLatePass(e.target.checked)} data-testid="late-pass" />
            {t("setup.latePass")}
          </label>
          <div className="flex flex-col gap-2">
            <div className="text-sm font-bold">{t("setup.payHow")}</div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={payAtClub} onChange={(e) => setPayAtClub(e.target.checked)} data-testid="pay-at-club" />
              {t("setup.payAtClub")}
            </label>
            <label className="block text-sm font-bold">
              {t("settings.promptpay")}
              <input className="input mt-1" value={promptpay} onChange={(e) => setPromptpay(e.target.value)} placeholder="08x xxx xxxx" inputMode="tel" autoComplete="off" maxLength={20} />
            </label>
            <label className="block text-sm font-bold">
              {t("settings.payLink")}
              <input className="input mt-1" value={payLink} onChange={(e) => setPayLink(e.target.value)} placeholder="https://" inputMode="url" autoComplete="off" maxLength={200} />
            </label>
          </div>
          <p className="text-xs text-faint">{t("setup.payNothingThrough")}</p>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <button type="button" className="btn-primary w-full" disabled={pending} onClick={savePay} data-testid="price-save">
            {pending ? "…" : t("setup.next")}
          </button>
          <button type="button" className="btn-ghost w-full" onClick={goNext}>
            {t("setup.later")}
          </button>
        </div>
      )}

      {step === "notify" && (
        <CoachNotify botUsername={botUsername} botUrl={botUrl} email={email} emailEnabled={emailEnabled} vapidPublicKey={vapidPublicKey} pushSubscribed={pushSubscribed} onReady={goNext} />
      )}

      {step === "link" && (
        <div className="flex flex-col gap-4">
          <div>
            <h2 className="text-xl font-extrabold tracking-tight">{t("setup.linkTitle")}</h2>
            <p className="mt-1 text-sm text-muted">{t("setup.linkHelp")}</p>
          </div>
          {link && (
            <>
              <code className="truncate rounded-lg bg-panel px-3 py-2 text-xs" data-testid="student-link">
                {link}
              </code>
              <ShareButtons url={link} text={t("invite.text", { url: link })} />
            </>
          )}
          {showImport ? (
            <ImportSheet />
          ) : (
            <button type="button" className="btn-ghost w-full" onClick={() => setShowImport(true)} data-testid="setup-import">
              {t("setup.importOffer")}
            </button>
          )}
          <button type="button" className="btn-secondary w-full" onClick={finish} data-testid="setup-finish">
            {t("setup.finish")}
          </button>
        </div>
      )}
    </section>
  );
}
