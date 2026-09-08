"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { acceptOfferAction, joinWaitlistAction, leaveWaitlistAction, requestCoachAction, requestTimeAction, studentBookAction, studentCancelAction } from "@/actions/coach";
import type { StudentStatus } from "@/lib/domain/coaching";
import { HowThisWorks } from "./HowThisWorks";

export type StudentLessonDTO = { id: string; iso: string; label: string; status: string; hoursUntil: number };
type Slot = { iso: string; day: string; time: string };
export type WaitDTO = { id: string; label: string; week: boolean };
export type OfferDTO = { id: string; label: string; minutesLeft: number };
export type RequestDTO = { id: string; label: string };
type Props = {
  handle: string;
  coachName: string;
  signedIn: boolean;
  status: StudentStatus;
  slots: Slot[];
  /** In the hours but already booked: tappable for the waitlist. */
  taken?: Slot[];
  days: string[];
  dayLabels: Record<string, string>;
  /** Monday of the week each day belongs to, for the week waitlist. */
  weekOf?: Record<string, string>;
  lessons: StudentLessonDTO[];
  pkg: { left: number; size: number; days: number | null } | null;
  cutoffHours: number;
  whatsappUrl: string | null;
  waits?: WaitDTO[];
  offers?: OfferDTO[];
  requests?: RequestDTO[];
  minLocal?: string;
};

/** The student's side of the book: ask once, then tap a free time. Cancel with the rule in plain words. */
export function StudentBooking({ handle, coachName, signedIn, status, slots, taken = [], days, dayLabels, weekOf = {}, lessons, pkg, cutoffHours, whatsappUrl, waits = [], offers = [], requests = [], minLocal }: Props) {
  const t = useTranslations("coach");
  const tRoot = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  const [day, setDay] = useState(days[0] ?? "");
  const [slot, setSlot] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const daySlots = slots.filter((s) => s.day === day);
  const dayTaken = taken.filter((s) => s.day === day);
  const [asking, setAsking] = useState(false);
  const [askLocal, setAskLocal] = useState("");
  const [askNote, setAskNote] = useState("");
  const chip = (active: boolean) => `rounded-full border px-3 py-1.5 text-sm font-bold transition ${active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-ink/40"}`;
  const errorText = (code: string) => (["slot_taken", "not_student", "outside_hours", "too_soon", "no_coach", "past"].includes(code) ? t(`errors.${code}` as "errors.slot_taken") : t("errors.slot_taken"));

  const request = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const r = await requestCoachAction(handle, signedIn ? null : name);
      if (!r.ok) {
        setError(errorText(r.error));
        return;
      }
      router.refresh();
    });
  };

  const book = () => {
    if (!slot) return;
    setError(null);
    start(async () => {
      const r = await studentBookAction(handle, slot);
      if (!r.ok) {
        setError(errorText(r.error));
        return;
      }
      const chosen = daySlots.find((s) => s.iso === slot);
      setNote(t("page.booked", { when: `${dayLabels[day] ?? day} ${chosen?.time ?? ""}` }));
      setSlot(null);
      router.refresh();
    });
  };

  const cancel = (l: StudentLessonDTO) => {
    const late = l.hoursUntil < cutoffHours;
    if (!confirm(`${t("page.cancelConfirm", { when: l.label })}\n${late ? t("page.cancelLate", { hours: cutoffHours }) : t("page.cancelFree", { hours: cutoffHours })}`)) return;
    start(async () => {
      const r = await studentCancelAction(l.id);
      if (!r.ok) {
        setError(errorText(r.error));
        return;
      }
      setNote(r.data.outcome === "free_pass" ? t("page.cancelledPass") : r.data.outcome === "counted" ? t("page.cancelledCounted") : t("page.cancelled"));
      router.refresh();
    });
  };

  const waitFor = (iso: string | null, weekStart: string | null, label: string) =>
    start(async () => {
      setError(null);
      const r = await joinWaitlistAction(handle, { slot: iso, weekStart });
      if (!r.ok) {
        setError(errorText(r.error));
        return;
      }
      setNote(iso ? t("page.waitlisted", { when: label }) : t("page.weekWaitlisted", { week: label }));
      router.refresh();
    });
  const takeOffer = (o: OfferDTO) =>
    start(async () => {
      setError(null);
      const r = await acceptOfferAction(handle, o.id);
      if (!r.ok) {
        setError(errorText(r.error));
        return;
      }
      setNote(t("page.requestBooked", { when: o.label }));
      router.refresh();
    });
  const leave = (id: string) =>
    start(async () => {
      await leaveWaitlistAction(handle, id);
      router.refresh();
    });
  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!askLocal) return;
    setError(null);
    start(async () => {
      const r = await requestTimeAction(handle, askLocal, askNote || null);
      if (!r.ok) {
        setError(errorText(r.error));
        return;
      }
      const when = new Date(askLocal).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
      setNote(r.data.kind === "booked" ? t("page.requestBooked", { when }) : t("page.asked", { name: coachName, when }));
      setAsking(false);
      setAskLocal("");
      setAskNote("");
      router.refresh();
    });
  };

  const pkgLine = pkg ? (pkg.days === null ? t("packageLineNoExpiry", { left: pkg.left, size: pkg.size }) : t("packageLine", { left: pkg.left, size: pkg.size, days: pkg.days })) : null;

  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        {status === "none" && (
          <form onSubmit={request} className="flex flex-col gap-3">
            {!signedIn && (
              <>
                <h2 className="text-xl font-extrabold tracking-tight">{t("page.nameFirst")}</h2>
                <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={tRoot("identity.namePlaceholder")} maxLength={40} autoComplete="given-name" autoFocus />
              </>
            )}
            <button type="submit" className="btn-primary w-full" disabled={pending || (!signedIn && !name.trim())}>
              {pending ? "…" : t("page.request")}
            </button>
          </form>
        )}
        {status === "requested" && <p className="text-sm font-semibold">⏳ {t("page.requested", { name: coachName })}</p>}
        {status === "paused" && <p className="text-sm font-semibold">{t("page.paused", { name: coachName })}</p>}
        {status === "accepted" && offers.length > 0 && (
          <div className="mb-4 flex flex-col gap-2 rounded-2xl bg-ok-soft px-4 py-3" data-testid="offers">
            <div className="text-sm font-extrabold text-ok">{t("page.offerTitle")}</div>
            {offers.map((o) => (
              <div key={o.id} className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold">{t("page.offerLine", { when: o.label, minutes: o.minutesLeft })}</span>
                <span className="flex shrink-0 gap-2">
                  <button type="button" className="btn-primary btn-xs" disabled={pending} onClick={() => takeOffer(o)} data-testid="offer-take">
                    {t("page.offerTake")}
                  </button>
                  <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => leave(o.id)}>
                    {t("page.offerNo")}
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}
        {status === "accepted" && (
          <div className="flex flex-col gap-3">
            <h2 className="text-xl font-extrabold tracking-tight">{t("page.book")}</h2>
            {days.length === 0 ? (
              <p className="text-sm text-muted">{t("page.noSlots", { name: coachName })}</p>
            ) : (
              <>
                <div>
                  <div className="text-xs font-bold uppercase text-faint">{t("page.pickDay")}</div>
                  <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
                    {days.map((d) => (
                      <button
                        key={d}
                        type="button"
                        data-kind="day"
                className={`${chip(day === d)} shrink-0`}
                        onClick={() => {
                          setDay(d);
                          setSlot(null);
                        }}
                      >
                        {dayLabels[d] ?? d}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-bold uppercase text-faint">{t("page.freeOn", { day: dayLabels[day] ?? day })}</div>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {daySlots.map((s) => (
                      <button key={s.iso} type="button" data-kind="time"
                className={chip(slot === s.iso)} onClick={() => setSlot(s.iso)}>
                        {s.time}
                      </button>
                    ))}
                    {dayTaken.map((s) => (
                      <button key={s.iso} type="button" data-kind="taken" title={t("page.taken")} className="rounded-full border border-dashed border-line px-3 py-1.5 text-sm font-bold text-faint line-through hover:border-ink/40 hover:text-muted" disabled={pending} onClick={() => waitFor(s.iso, null, `${dayLabels[day] ?? day} ${s.time}`)}>
                        {s.time}
                      </button>
                    ))}
                  </div>
                  {dayTaken.length > 0 && <p className="mt-1 text-xs text-faint">{t("page.taken")}</p>}
                </div>
                <button type="button" className="btn-primary w-full" disabled={!slot || pending} onClick={book}>
                  {pending ? "…" : slot ? t("page.confirm", { when: `${dayLabels[day] ?? day} ${daySlots.find((s) => s.iso === slot)?.time ?? ""}` }) : t("page.book")}
                </button>
                {weekOf[day] && (
                  <button type="button" className="self-start text-xs text-faint hover:text-muted" disabled={pending} onClick={() => waitFor(null, weekOf[day], weekOf[day])} data-testid="week-wait">
                    {t("page.weekWait")}
                  </button>
                )}
              </>
            )}
            {!asking ? (
              <button type="button" className="self-start text-xs text-faint hover:text-muted" onClick={() => setAsking(true)} data-testid="other-time">
                {t("page.otherTime")} →
              </button>
            ) : (
              <form onSubmit={ask} className="flex flex-col gap-2 rounded-2xl border border-line bg-white p-3 animate-pop" data-testid="ask-form">
                <p className="text-xs text-muted">{t("page.otherTimeHelp", { name: coachName })}</p>
                <input type="datetime-local" className="input" value={askLocal} min={minLocal} onChange={(e) => setAskLocal(e.target.value)} required />
                <input className="input" value={askNote} onChange={(e) => setAskNote(e.target.value)} placeholder={t("page.otherTimeNote")} maxLength={200} />
                <div className="flex gap-2">
                  <button type="submit" className="btn-primary flex-1" disabled={pending || !askLocal}>
                    {pending ? "…" : t("page.ask", { name: coachName })}
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setAsking(false)}>
                    {tRoot("common.cancel")}
                  </button>
                </div>
              </form>
            )}
            {(waits.length > 0 || requests.length > 0) && (
              <ul className="flex flex-col gap-1 text-xs text-muted" data-testid="waits">
                {waits.map((w) => (
                  <li key={w.id} className="flex items-center justify-between gap-2">
                    <span>⏳ {t("page.waitingFor")} {w.label}</span>
                    <button type="button" className="underline underline-offset-4 hover:text-ink" disabled={pending} onClick={() => leave(w.id)}>
                      {t("page.leaveList")}
                    </button>
                  </li>
                ))}
                {requests.map((r) => (
                  <li key={r.id}>❔ {t("page.askedList")} {r.label}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {note && <p className="mt-3 rounded-2xl bg-ok-soft px-4 py-2 text-sm font-semibold text-ok">{note}</p>}
        {error && <p className="mt-3 text-sm font-semibold text-danger">{error}</p>}
        {whatsappUrl && (status === "paused" || status === "requested" || days.length === 0) && (
          <a href={whatsappUrl} target="_blank" rel="noreferrer" className="btn-ghost mt-3 w-full">
            💬 {t("page.whatsapp")}
          </a>
        )}
      </section>

      {(lessons.length > 0 || pkgLine) && (
        <section className="card">
          <h2 className="text-lg font-extrabold">{t("page.yourLessons")}</h2>
          {pkgLine && (
            <p className="mt-1 text-sm text-muted">
              {t("page.yourPackage")}: <strong className="text-ink">{pkgLine}</strong>
            </p>
          )}
          <ul className="mt-3 flex flex-col gap-2">
            {lessons.map((l) => (
              <li key={l.id} className="flex items-center justify-between gap-3 rounded-2xl border border-line bg-white px-4 py-3">
                <div className="font-bold">{l.label}</div>
                {l.status === "booked" && (
                  <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => cancel(l)}>
                    {t("page.cancel")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      <HowThisWorks text={t("page.how", { hours: cutoffHours })} />
    </div>
  );
}
