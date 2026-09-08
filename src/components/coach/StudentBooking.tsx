"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { requestCoachAction, studentBookAction, studentCancelAction } from "@/actions/coach";
import type { StudentStatus } from "@/lib/domain/coaching";
import { HowThisWorks } from "./HowThisWorks";

export type StudentLessonDTO = { id: string; iso: string; label: string; status: string; hoursUntil: number };
type Slot = { iso: string; day: string; time: string };
type Props = {
  handle: string;
  coachName: string;
  signedIn: boolean;
  status: StudentStatus;
  slots: Slot[];
  days: string[];
  dayLabels: Record<string, string>;
  lessons: StudentLessonDTO[];
  pkg: { left: number; size: number; days: number | null } | null;
  cutoffHours: number;
  whatsappUrl: string | null;
};

/** The student's side of the book: ask once, then tap a free time. Cancel with the rule in plain words. */
export function StudentBooking({ handle, coachName, signedIn, status, slots, days, dayLabels, lessons, pkg, cutoffHours, whatsappUrl }: Props) {
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
                  </div>
                </div>
                <button type="button" className="btn-primary w-full" disabled={!slot || pending} onClick={book}>
                  {pending ? "…" : slot ? t("page.confirm", { when: `${dayLabels[day] ?? day} ${daySlots.find((s) => s.iso === slot)?.time ?? ""}` }) : t("page.book")}
                </button>
              </>
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
