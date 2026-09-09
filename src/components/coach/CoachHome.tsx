"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { QRCodeSVG } from "qrcode.react";
import { coachBookAction, coachCancelAction, coachNoShowAction, decideRequestAction } from "@/actions/coach";
import { ShareButtons } from "@/components/ShareSheet";
import { LevelChecks, type LevelCheckDTO } from "@/components/LevelChecks";
import { HowThisWorks } from "./HowThisWorks";

export type LessonDTO = { id: string; iso: string; day: string; time: string; dayLabel: string; studentName: string; studentPlayerId: string | null; status: string; pkg: { left: number; size: number; days: number | null } | null };
export type SlotDTO = { iso: string; day: string; time: string };
export type StudentOption = { id: string; name: string };

export type RequestDTO = { id: string; name: string; label: string; note: string | null };
export type MonthDTO = { label: string; done: number; noShows: number };
type Props = {
  handle: string;
  /** How students know the coach; the forwarded text speaks as their assistant. */
  coachName: string;
  url: string;
  /** The link the coach forwards: their page with the invite code, so a student lands on the list. */
  studentUrl: string;
  today: string;
  welcome: boolean;
  students: StudentOption[];
  lessons: LessonDTO[];
  slots: SlotDTO[];
  dayLabels: Record<string, string>;
  days: string[];
  requests?: RequestDTO[];
  waiting?: number;
  month?: MonthDTO | null;
  levelChecks?: LevelCheckDTO[];
  /** The assistant has proved itself (a few students, a few lessons): only then is the coach asked to pass it on. */
  earned?: boolean;
};

/** The coach's book: today, the next days, one button to book. Everything else behind "More". */
export function CoachHome({ handle, coachName, url, studentUrl, today, welcome, students, lessons, slots, dayLabels, days, requests = [], waiting = 0, month = null, levelChecks = [], earned = false }: Props) {
  const t = useTranslations("coach");
  const tRoot = useTranslations();
  // The coach's own door for other coaches: the front page, tagged, so the digest can count who invited whom in.
  const inviteUrl = `${url.replace(/\/c\/[^/]+$/, "")}/coaches?s=invite`;
  const router = useRouter();
  const [pending, start] = useTransition();
  const [booking, setBooking] = useState(false);
  const [more, setMore] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const todayLessons = lessons.filter((l) => l.day === today);
  const later = lessons.filter((l) => l.day > today);
  const byDay = useMemo(() => {
    const m = new Map<string, LessonDTO[]>();
    for (const l of later) m.set(l.day, [...(m.get(l.day) ?? []), l]);
    return [...m.entries()];
  }, [later]);

  const errorText = (code: string) => (["slot_taken", "not_student", "outside_hours", "too_soon", "no_coach", "past"].includes(code) ? t(`errors.${code}` as "errors.slot_taken") : t("errors.slot_taken"));

  const cancel = (l: LessonDTO) => {
    if (!confirm(t("home.cancelConfirm", { name: l.studentName }))) return;
    start(async () => {
      const r = await coachCancelAction(l.id);
      if (!r.ok) setError(errorText(r.error));
      router.refresh();
    });
  };
  const noShow = (l: LessonDTO) =>
    start(async () => {
      await coachNoShowAction(l.id);
      router.refresh();
    });
  const decide = (r: RequestDTO, accept: boolean) =>
    start(async () => {
      const res = await decideRequestAction(r.id, accept);
      if (!res.ok) setError(errorText(res.error));
      router.refresh();
    });

  const pkgLine = (l: LessonDTO) => (l.pkg ? (l.pkg.days === null ? t("packageLineNoExpiry", { left: l.pkg.left, size: l.pkg.size }) : t("packageLine", { left: l.pkg.left, size: l.pkg.size, days: l.pkg.days })) : t("noPackage"));

  const row = (l: LessonDTO) => (
    <li key={l.id} className={`flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3 ${l.status !== "booked" && l.status !== "done" ? "opacity-60" : ""}`}>
      <div className="w-14 shrink-0 text-xl font-extrabold leading-none tabular-nums">{l.time}</div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-bold">{l.studentName}</div>
        <div className="truncate text-xs text-muted">
          {pkgLine(l)}
          {l.status !== "booked" ? ` · ${t(`home.status.${l.status}` as "home.status.done")}` : ""}
        </div>
      </div>
      {l.status === "booked" && (
        <button type="button" className="btn-ghost btn-xs" onClick={() => cancel(l)} disabled={pending}>
          {t("home.cancel")}
        </button>
      )}
      {l.status === "done" && l.day === today && (
        <button type="button" className="btn-ghost btn-xs" onClick={() => noShow(l)} disabled={pending}>
          {t("home.noShow")}
        </button>
      )}
    </li>
  );

  return (
    <div className="flex flex-col gap-4">
      {welcome && (
        <section className="card animate-pop" data-testid="coach-welcome">
          <h1 className="text-2xl font-extrabold tracking-tight">🎾 {t("done.title")}</h1>
          <p className="mt-3 text-sm font-bold">{t("done.link")}</p>
          <p className="mt-1 break-all font-mono text-sm">{url}</p>
          <p className="mt-4 text-sm font-bold">{t("done.forward")}</p>
          <div className="mt-2">
            <ShareButtons url={studentUrl} text={t("done.forwardText", { coach: coachName, url: studentUrl })} size="sm" />
          </div>
          <div className="mt-4">
            <Link href="/coach" prefetch={false} className="btn-secondary" onClick={() => router.replace("/coach")}>
              {t("done.open")}
            </Link>
          </div>
        </section>
      )}

      {requests.length > 0 && (
        <section className="card animate-pop" data-testid="coach-requests">
          <div className="text-sm font-extrabold">{t("home.requests")}</div>
          <ul className="mt-2 flex flex-col gap-2">
            {requests.map((r) => (
              <li key={r.id} className="flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{r.name} · {r.label}</div>
                  {r.note && <div className="truncate text-xs text-muted">“{r.note}”</div>}
                </div>
                <button type="button" className="btn-primary btn-xs" disabled={pending} onClick={() => decide(r, true)}>
                  ✓ {t("home.yes")}
                </button>
                <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => decide(r, false)}>
                  ✕ {t("home.no")}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <LevelChecks checks={levelChecks} by={{ kind: "coach" }} />
      <section className="card">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-3xl font-extrabold tracking-tight">{t("home.title")}</h1>
          <span className="text-sm text-muted">{dayLabels[today]}</span>
        </div>
        {(waiting > 0 || month) && (
          <p className="mt-1 text-xs text-faint" data-testid="coach-pulse">
            {month ? t("home.month", { month: month.label, done: month.done, noShows: month.noShows }) : ""}
            {month && waiting > 0 ? " · " : ""}
            {waiting > 0 ? t("home.waiting", { count: waiting }) : ""}
          </p>
        )}
        {todayLessons.length > 0 ? <ul className="mt-3 flex flex-col gap-2">{todayLessons.map(row)}</ul> : <p className="mt-3 text-sm text-muted">{lessons.length === 0 ? t("home.none") : "—"}</p>}
        {note && <p className="mt-3 rounded-2xl bg-ok-soft px-4 py-2 text-sm font-semibold text-ok">{note}</p>}
        {error && <p className="mt-3 text-sm font-semibold text-danger">{error}</p>}
        {!booking ? (
          <button type="button" className="btn-primary mt-4 w-full" onClick={() => setBooking(true)}>
            {t("home.book")}
          </button>
        ) : (
          <BookForm
            students={students}
            slots={slots}
            days={days}
            dayLabels={dayLabels}
            onDone={(text) => {
              setBooking(false);
              setNote(text);
              router.refresh();
            }}
            onCancel={() => setBooking(false)}
          />
        )}
      </section>

      {byDay.length > 0 && (
        <section className="card">
          <h2 className="text-lg font-extrabold">{t("home.upcoming")}</h2>
          <div className="mt-3 flex flex-col gap-4">
            {byDay.map(([day, ls]) => (
              <div key={day}>
                <div className="text-xs font-bold uppercase text-faint">{dayLabels[day] ?? day}</div>
                <ul className="mt-1 flex flex-col gap-2">{ls.map(row)}</ul>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="text-sm">
        <button type="button" className="text-muted hover:text-ink" aria-expanded={more} onClick={() => setMore((v) => !v)}>
          {more ? "▾" : "▸"} {t("home.more")}
        </button>
        {more && (
          <ul className="mt-2 flex flex-col gap-2 animate-pop">
            <li>
              <Link href="/coach/students" prefetch={false} className="font-bold underline underline-offset-4">
                {t("home.students")}
              </Link>
            </li>
            <li>
              <Link href="/coach/settings" prefetch={false} className="font-bold underline underline-offset-4">
                {t("home.settings")}
              </Link>
            </li>
            <li>
              <Link href="/me" prefetch={false} className="font-bold underline underline-offset-4">
                {tRoot("common.myMatches")}
              </Link>
            </li>
            <li className="text-muted">
              {t("home.link")}: <span className="font-mono">{url}</span> · <span className="font-mono">/c/{handle}</span>
            </li>
            <li>
              <div className="text-sm font-bold">{t("done.forward")}</div>
              <div className="mt-1">
                <ShareButtons url={studentUrl} text={t("done.forwardText", { coach: coachName, url: studentUrl })} size="sm" />
              </div>
            </li>
            <li>
              <details>
                <summary className="cursor-pointer font-bold">{t("done.qr")}</summary>
                <div className="mt-2 inline-block rounded-xl border border-line bg-white p-2">
                  <QRCodeSVG value={studentUrl} size={160} level="M" bgColor="#ffffff" fgColor="#14161a" marginSize={1} />
                </div>
              </details>
            </li>
          </ul>
        )}
      </div>
      <HowThisWorks text={t("home.how")} />
      {earned && (
        <details className="px-1 text-xs text-faint" data-testid="invite-coach">
          <summary className="cursor-pointer hover:text-muted">{t("invite.title")}</summary>
          <div className="mt-2">
            <ShareButtons url={inviteUrl} text={t("invite.text", { url: inviteUrl })} size="sm" />
          </div>
        </details>
      )}
    </div>
  );
}

function BookForm({ students, slots, days, dayLabels, onDone, onCancel }: { students: StudentOption[]; slots: SlotDTO[]; days: string[]; dayLabels: Record<string, string>; onDone: (text: string) => void; onCancel: () => void }) {
  const t = useTranslations("coach");
  const [pending, start] = useTransition();
  const [studentId, setStudentId] = useState<string>(students[0]?.id ?? "new");
  const [newName, setNewName] = useState("");
  const [day, setDay] = useState(days[0] ?? "");
  const [slot, setSlot] = useState<string | null>(null);
  const [customTime, setCustomTime] = useState("");
  const [error, setError] = useState<string | null>(null);
  const daySlots = slots.filter((s) => s.day === day);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const name = studentId === "new" ? newName : (students.find((s) => s.id === studentId)?.name ?? "");
      const r = await coachBookAction({ studentPlayerId: studentId === "new" ? null : studentId, newName: studentId === "new" ? newName : null, startsAt: slot, day: slot ? null : day, time: slot ? null : customTime || null });
      if (!r.ok) {
        setError(["slot_taken", "not_student", "outside_hours", "too_soon", "no_coach", "past"].includes(r.error) ? t(`errors.${r.error}` as "errors.slot_taken") : t("errors.slot_taken"));
        return;
      }
      const chosen = slot ? daySlots.find((s) => s.iso === slot) : null;
      onDone(t("book.booked", { name, when: `${dayLabels[day] ?? day} ${chosen?.time ?? customTime}` }));
    });
  };

  const chip = (active: boolean) => `rounded-full border px-3 py-1.5 text-sm font-bold transition ${active ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-ink/40"}`;

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-4 rounded-2xl border border-line bg-bg p-4 animate-pop">
      <div>
        <label className="text-sm font-bold" htmlFor="book-student">
          {t("book.student")}
        </label>
        <select id="book-student" className="input mt-2" value={studentId} onChange={(e) => setStudentId(e.target.value)}>
          {students.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
          <option value="new">＋ {t("book.newStudent")}</option>
        </select>
        {studentId === "new" && <input className="input mt-2" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("book.newStudentName")} maxLength={40} autoFocus />}
      </div>
      <div>
        <div className="text-sm font-bold">{t("book.day")}</div>
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
        <div className="text-sm font-bold">{t("book.freeTimes")}</div>
        {daySlots.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-2">
            {daySlots.map((s) => (
              <button
                key={s.iso}
                type="button"
                data-kind="time"
                className={chip(slot === s.iso)}
                onClick={() => {
                  setSlot(s.iso);
                  setCustomTime("");
                }}
              >
                {s.time}
              </button>
            ))}
          </div>
        ) : (
          <p className="mt-1 text-xs text-muted">{t("book.noSlots")}</p>
        )}
        <label className="mt-3 block text-xs font-bold text-muted" htmlFor="book-time">
          {t("book.otherTime")}
        </label>
        <input
          id="book-time"
          type="time"
          className="input mt-1 w-40"
          value={customTime}
          onChange={(e) => {
            setCustomTime(e.target.value);
            setSlot(null);
          }}
        />
      </div>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-primary flex-1" disabled={pending || (!slot && !customTime) || (studentId === "new" && !newName.trim())}>
          {pending ? "…" : t("book.confirm")}
        </button>
        <button type="button" className="btn-ghost" onClick={onCancel}>
          ✕
        </button>
      </div>
      <HowThisWorks text={t("book.how")} />
    </form>
  );
}
