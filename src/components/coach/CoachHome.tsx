"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { coachBlockAction, coachBookAction, coachCancelAction, coachNoShowAction, coachOpenAction, coachSetLessonPaidAction, coachUndoNoShowAction, compLessonAction, decideRequestAction, setLessonAmountAction } from "@/actions/coach";
import { ShareButtons } from "@/components/ShareSheet";
import { LevelChecks, type LevelCheckDTO } from "@/components/LevelChecks";
import { HowThisWorks } from "./HowThisWorks";

export type LessonDTO = { id: string; iso: string; day: string; time: string; dayLabel: string; studentName: string; studentPlayerId: string | null; status: string; heads?: number; minutes?: number; comped?: string | null; amount?: number | null; currency?: string; paid?: boolean; claimed?: boolean; hasSlip?: boolean; pkg: { left: number; size: number; days: number | null } | null };
export type SlotDTO = { iso: string; day: string; time: string };
export type StudentOption = { id: string; name: string };

export type RequestDTO = { id: string; name: string; label: string; note: string | null };
export type MonthDTO = { label: string; done: number; noShows: number };
type Props = {
  handle: string;
  url: string;
  /** The coach's own door for other coaches: the front page, tagged, so the digest can count who invited whom in. */
  inviteUrl: string;
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
  /** The lengths this coach sells: the usual one first. Two of them put a picker on the book form. */
  lengths?: number[];
  /** Free times for the second length: a longer lesson needs a longer hole. */
  slotsSecond?: SlotDTO[];
  /** What a player compares on and this card does not answer, in the order they read it. */
  gaps?: ("photo" | "bio" | "price" | "levels")[];
};

/** The coach's book: today, the next days, one button to book. Three doors to the other screens above it. */
export function CoachHome({ handle, url, inviteUrl, studentUrl, today, welcome, students, lessons, slots, dayLabels, days, requests = [], waiting = 0, month = null, levelChecks = [], earned = false, lengths = [], slotsSecond = [], gaps = [] }: Props) {
  const t = useTranslations("coach");
  const tRoot = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [booking, setBooking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A book with nobody in it: the one thing that can move it forward is the link, so the link is the
  // primary action there and booking steps back. "No lessons booked yet. Share your link" used to
  // point at a link that was two taps away behind "More".
  const emptyBook = !welcome && students.length === 0 && lessons.length === 0;
  const todayLessons = lessons.filter((l) => l.day === today);
  const later = lessons.filter((l) => l.day > today);
  const byDay = useMemo(() => {
    const m = new Map<string, LessonDTO[]>();
    for (const l of later) m.set(l.day, [...(m.get(l.day) ?? []), l]);
    return [...m.entries()];
  }, [later]);

  const errorText = (code: string) => (["slot_taken", "not_student", "outside_hours", "too_soon", "no_coach", "past", "already_paid"].includes(code) ? t(`errors.${code}` as "errors.slot_taken") : t("errors.slot_taken"));

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
  // The tap taken back, on the row it was made on. A confirm on every no-show would tax the real
  // ones; an undo costs only the coach who needs it.
  const undoNoShow = (l: LessonDTO) =>
    start(async () => {
      await coachUndoNoShowAction(l.id);
      router.refresh();
    });
  // A tip, a rounding, a weekend at double rate: the coach's book, the coach's number.
  const editAmount = (l: LessonDTO) => {
    const raw = prompt(t("home.amountPrompt", { name: l.studentName, currency: l.currency ?? "" }), String(l.amount ?? 0));
    if (raw === null) return;
    const n = Number(raw.replace(/[^\d]/g, ""));
    if (!Number.isFinite(n)) return;
    start(async () => {
      const r = await setLessonAmountAction(l.id, n);
      if (!r.ok) setError(errorText(r.error));
      router.refresh();
    });
  };
  /** "On me." The reason is asked for once and reaches the student, because a gift nobody reads is a number. */
  /** The coach's tap is the only thing that marks a lesson paid; un-marking is a correction to their own book. */
  const markPaid = (l: LessonDTO, paid: boolean) =>
    start(async () => {
      const r = await coachSetLessonPaidAction(l.id, paid);
      if (!r.ok) setError(errorText(r.error));
      router.refresh();
    });
  const comp = (l: LessonDTO) => {
    // "On me" over "I already paid" is the one collision that costs a friendship. The book refuses a
    // lesson the coach marked paid; one the student merely claims is the coach's call, asked once.
    if (l.claimed && !confirm(t("home.compClaimed", { name: l.studentName, amount: `${l.amount ?? 0} ${l.currency ?? ""}`.trim() }))) return;
    const why = prompt(t("book.compWhy"), "");
    if (why === null) return;
    start(async () => {
      const r = await compLessonAction(l.id, why);
      if (!r.ok) setError(errorText(r.error));
      router.refresh();
    });
  };
  const decide = (r: RequestDTO, accept: boolean) =>
    start(async () => {
      const res = await decideRequestAction(r.id, accept);
      if (!res.ok) setError(errorText(res.error));
      router.refresh();
    });

  const pkgLine = (l: LessonDTO) => (l.pkg ? (l.pkg.days === null ? t("packageLineNoExpiry", { left: l.pkg.left, size: l.pkg.size }) : t("packageLine", { left: l.pkg.left, size: l.pkg.size, days: l.pkg.days })) : t("noPackage"));

  const row = (l: LessonDTO) => (
    // A row built for one button carries up to three now. It wraps: the time and the text claim the
    // first line, and on a phone the buttons drop underneath rather than crushing the name to nothing.
    // A cancelled or missed lesson is dimmed by its text, never by the row: a dimmed row made the one
    // button it still carries ("They came after all") look disabled.
    <li key={l.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-line bg-white px-4 py-3" data-status={l.status}>
      <div className={`w-14 shrink-0 text-xl font-extrabold leading-none tabular-nums ${l.status !== "booked" && l.status !== "done" ? "opacity-60" : ""}`}>{l.time}</div>
      <div className={`min-w-0 flex-1 basis-40 ${l.status !== "booked" && l.status !== "done" ? "opacity-60" : ""}`}>
        {/* The name opens this student on the students screen: their package, what they owe, their
            lessons — one tap instead of a screen change and a scroll. */}
        <div className="truncate font-bold">
          {l.studentPlayerId ? (
            <Link href={`/coach/students#s-${l.studentPlayerId}`} prefetch={false} className="underline-offset-4 hover:underline" title={t("students.jumpTo", { name: l.studentName })} data-testid="lesson-student">
              {l.studentName}
            </Link>
          ) : (
            l.studentName
          )}
        </div>
        <div className="truncate text-xs text-muted">
          {pkgLine(l)}
          {(l.heads ?? 1) > 1 ? ` · ${l.heads}` : ""}
          {l.minutes != null && lengths.length > 1 && l.minutes !== lengths[0] ? ` · ${t("minutes", { n: l.minutes })}` : ""}
          {l.status !== "booked" ? ` · ${t(`home.status.${l.status}` as "home.status.done")}` : ""}
          {l.comped != null ? ` · ${t("book.comp")}${l.comped ? ` — ${l.comped}` : ""}` : ""}
        </div>
        {/* The money, on the row. Until now a coach saw "no package" and nothing else, and learned that a
            student had paid from a notice that scrolled away. */}
        {(l.amount ?? 0) > 0 && l.comped == null && (
          <div className={`text-xs font-bold ${l.paid ? "text-ok" : l.claimed ? "text-ink" : "text-danger"}`} data-testid="lesson-money">
            {t(l.paid ? "home.paid" : l.claimed ? "home.saysPaid" : "home.unpaid", { amount: `${l.amount} ${l.currency ?? ""}`.trim() })}
            {l.hasSlip && (
              <>
                {" · "}
                <a href={`/c/${handle}/slip/${l.id}`} target="_blank" rel="noopener noreferrer" className="link">
                  {t("home.slip")}
                </a>
              </>
            )}
          </div>
        )}
      </div>
      <div className="ml-auto flex shrink-0 flex-wrap justify-end gap-2">
      {(l.amount ?? 0) > 0 && l.comped == null && !l.paid && (
        <button type="button" className="btn-secondary btn-xs" onClick={() => markPaid(l, true)} disabled={pending} data-testid="mark-paid">
          {t("home.markPaid")}
        </button>
      )}
      {l.amount != null && l.comped == null && (
        <button type="button" className="btn-ghost btn-xs" onClick={() => editAmount(l)} disabled={pending} data-testid="edit-amount" aria-label={t("home.editAmount")} title={t("home.editAmount")}>
          ✎
        </button>
      )}
      {(l.amount ?? 0) > 0 && l.paid && (
        <button type="button" className="btn-ghost btn-xs" onClick={() => markPaid(l, false)} disabled={pending}>
          {t("home.unmarkPaid")}
        </button>
      )}
      {l.comped == null && (l.status === "booked" || l.status === "done") && (
        <button type="button" className="btn-ghost btn-xs" onClick={() => comp(l)} disabled={pending} data-testid="comp-lesson">
          {t("book.comp")}
        </button>
      )}
      {l.status === "booked" && (
        <button type="button" className="btn-ghost btn-xs" onClick={() => cancel(l)} disabled={pending}>
          {t("home.cancel")}
        </button>
      )}
      {l.status === "done" && l.day === today && (
        <button type="button" className="btn-ghost btn-xs" onClick={() => noShow(l)} disabled={pending} data-testid="no-show">
          {t("home.noShow")}
        </button>
      )}
      {l.status === "no_show" && (
        <button type="button" className="btn-ghost btn-xs" onClick={() => undoNoShow(l)} disabled={pending} data-testid="undo-no-show">
          ↩ {t("home.undoNoShow")}
        </button>
      )}
      </div>
    </li>
  );

  // Each gap is its own link, straight to the field. The same notice has been in the settings screen
  // since Tier 1 and both live coaches are listed with all four missing: a coach opens their book,
  // not their settings.
  const GAP_FIELD: Record<string, string> = { photo: "photo", bio: "bio", price: "price", levels: "levels" };

  return (
    <div className="flex flex-col gap-4">
      {gaps.length > 0 && (
        <section className="card border-warn bg-warn-soft" data-testid="coach-gaps">
          <div className="font-extrabold">{t("settings.cardGapTitle")}</div>
          <p className="mt-1 text-sm text-ink-soft">{t("settings.cardGap", { gaps: gaps.map((g) => t(`settings.gap${g[0].toUpperCase()}${g.slice(1)}` as "settings.gapPhoto")).join(", ") })}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {gaps.map((g) => (
              <Link key={g} href={`/coach/settings#${GAP_FIELD[g]}`} prefetch={false} className="btn-secondary btn-sm" data-testid={`gap-${g}`}>
                {t(`settings.gap${g[0].toUpperCase()}${g.slice(1)}` as "settings.gapPhoto")} · {t("home.gapFix")}
              </Link>
            ))}
          </div>
          {/* The card itself persuades better than a sentence about it, and this link costs no query. */}
          <Link href={`/c/${handle}`} prefetch={false} className="link mt-3 inline-block text-sm" data-testid="gap-see-page">
            {t("home.gapSeePage")} →
          </Link>
        </section>
      )}
      {welcome && (
        <section className="card animate-pop" data-testid="coach-welcome">
          <h1 className="text-2xl font-extrabold tracking-tight">🎾 {t("done.title")}</h1>
          <p className="mt-3 text-sm font-bold">{t("done.link")}</p>
          <p className="mt-1 break-all font-mono text-sm">{url}</p>
          {/* The bare link is the one for Instagram; the students they already have take the invite link, which seats them without asking (the owner's decision). */}
          <p className="mt-1 text-xs text-muted">{t("done.inviteHint")}</p>
          <p className="mt-4 text-sm font-bold">{t("done.forward")}</p>
          <div className="mt-2">
            <ShareButtons url={studentUrl} text={t("done.studentMessage", { url: studentUrl })} size="sm" />
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
      {/* The three other screens, as three doors in a row. They used to sit under a "More" toggle
          with the link, the share buttons and a QR, and a coach opening it found a list. */}
      <nav className="grid grid-cols-3 gap-2" aria-label={t("home.more")} data-testid="coach-nav">
        <NavTile href="/coach/students" icon="👥" label={t("home.students")} />
        <NavTile href="/coach/settings" icon="⚙️" label={t("home.settings")} />
        <NavTile href="/me" icon="🎾" label={tRoot("common.myMatches")} />
      </nav>
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
        {emptyBook && (
          <div className="mt-4" data-testid="coach-empty-share">
            <div className="text-sm font-bold">{t("done.forward")}</div>
            <p className="mt-1 break-all font-mono text-xs text-muted">{studentUrl}</p>
            <div className="mt-2">
              <ShareButtons url={studentUrl} text={t("done.studentMessage", { url: studentUrl })} size="sm" />
            </div>
          </div>
        )}
        {!booking ? (
          <button type="button" className={`mt-4 w-full ${emptyBook ? "btn-secondary" : "btn-primary"}`} onClick={() => setBooking(true)}>
            {t("home.book")}
          </button>
        ) : (
          <BookForm
            students={students}
            lengths={lengths}
            slots={slots}
            slotsSecond={slotsSecond}
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

/** One door: an icon, a word, the whole tile tappable. */
function NavTile({ href, icon, label }: { href: string; icon: string; label: string }) {
  return (
    <Link href={href} prefetch={false} className="flex min-h-16 flex-col items-center justify-center gap-1 rounded-2xl border border-line bg-white px-2 py-2 text-center text-xs font-bold leading-tight text-ink shadow-card transition hover:border-ink/40 active:scale-[0.98]">
      <span className="text-xl leading-none" aria-hidden="true">{icon}</span>
      <span>{label}</span>
    </Link>
  );
}

function BookForm({ students, slots, slotsSecond, days, dayLabels, lengths, onDone, onCancel }: { students: StudentOption[]; slots: SlotDTO[]; slotsSecond: SlotDTO[]; days: string[]; dayLabels: Record<string, string>; lengths: number[]; onDone: (text: string) => void; onCancel: () => void }) {
  const t = useTranslations("coach");
  const [pending, start] = useTransition();
  // Which length, when the coach sells two. The usual one unless they say otherwise.
  const [minutes, setMinutes] = useState<number | null>(null);
  const [studentId, setStudentId] = useState<string>(students[0]?.id ?? "new");
  const [newName, setNewName] = useState("");
  const [day, setDay] = useState(days[0] ?? "");
  const [slot, setSlot] = useState<string | null>(null);
  const [customTime, setCustomTime] = useState("");
  // How many are on court, which picks the price. One unless the coach says otherwise, so the common
  // case costs no taps and nobody has to think about it.
  const [heads, setHeads] = useState(1);
  const [error, setError] = useState<string | null>(null);
  // The free times of the length picked: a 90-minute lesson at a 60-minute hole would only bounce
  // as "taken", which is the wrong word for it.
  const daySlots = (minutes != null && lengths.length > 1 && minutes === lengths[1] ? slotsSecond : slots).filter((s) => s.day === day);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    start(async () => {
      const name = studentId === "new" ? newName : (students.find((s) => s.id === studentId)?.name ?? "");
      const r = await coachBookAction({ studentPlayerId: studentId === "new" ? null : studentId, newName: studentId === "new" ? newName : null, startsAt: slot, day: slot ? null : day, time: slot ? null : customTime || null, heads, minutes });
      if (!r.ok) {
        setError(["slot_taken", "not_student", "outside_hours", "too_soon", "no_coach", "past"].includes(r.error) ? t(`errors.${r.error}` as "errors.slot_taken") : t("errors.slot_taken"));
        return;
      }
      const chosen = slot ? daySlots.find((s) => s.iso === slot) : null;
      onDone(t("book.booked", { name, when: `${dayLabels[day] ?? day} ${chosen?.time ?? customTime}` }));
    });
  };

  /**
   * The other direction: this hour is open on this date, whatever the week says. The typed time above
   * is the only way in, because the grid can only draw hours the template already knows about.
   */
  const open = () =>
    start(async () => {
      setError(null);
      const r = await coachOpenAction({ startsAt: slot, day: slot ? null : day, time: slot ? null : customTime || null });
      if (!r.ok) {
        setError(["slot_taken", "past", "no_coach"].includes(r.error) ? t(`errors.${r.error}` as "errors.slot_taken") : t("errors.slot_taken"));
        return;
      }
      const chosen = slot ? daySlots.find((s) => s.iso === slot) : null;
      onDone(t("book.opened", { when: `${dayLabels[day] ?? day} ${chosen?.time ?? customTime}` }));
    });

  const block = () =>
    start(async () => {
      setError(null);
      const r = await coachBlockAction({ startsAt: slot, day: slot ? null : day, time: slot ? null : customTime || null });
      if (!r.ok) {
        setError(["slot_taken", "past", "no_coach"].includes(r.error) ? t(`errors.${r.error}` as "errors.slot_taken") : t("errors.slot_taken"));
        return;
      }
      const chosen = slot ? daySlots.find((s) => s.iso === slot) : null;
      onDone(t("book.blocked", { when: `${dayLabels[day] ?? day} ${chosen?.time ?? customTime}` }));
    });

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
      {lengths.length > 1 && (
        <div>
          <div className="text-sm font-bold">{t("book.length")}</div>
          <div className="mt-2 flex gap-2" role="radiogroup" aria-label={t("book.length")} data-testid="book-length">
            {lengths.map((m) => (
              <button key={m} type="button" role="radio" aria-checked={(minutes ?? lengths[0]) === m} data-minutes={m} className={chip((minutes ?? lengths[0]) === m)} onClick={() => (setMinutes(m), setSlot(null))}>
                {t("minutes", { n: m })}
              </button>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="text-sm font-bold">{t("book.heads")}</div>
        {/* A padel court holds four. One is the common case, so it costs no taps. */}
        <div className="mt-2 flex gap-2" role="radiogroup" aria-label={t("book.heads")}>
          {[1, 2, 3, 4].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={heads === n}
              data-heads={n}
              className={`rounded-full border px-4 py-1.5 text-sm font-bold transition ${heads === n ? "border-ink bg-ink text-white" : "border-line bg-white text-ink hover:border-ink/40"}`}
              onClick={() => setHeads(n)}
            >
              {n}
            </button>
          ))}
        </div>
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
      {/* The same picker takes an hour back for the coach. This is what connecting Google Calendar was
          standing in for, and unlike that it can be done on a phone, on the screen they are already on. */}
      <button type="button" className="btn-ghost w-full text-sm" disabled={pending || (!slot && !customTime)} onClick={block} data-testid="block-time">
        {t("book.blockIt")}
      </button>
      {/* And the other way: an hour outside the week, open on this date alone. Only for a typed time —
          a time the grid already offers is open by definition. */}
      {!slot && customTime && (
        <button type="button" className="btn-ghost w-full text-sm" disabled={pending} onClick={open} data-testid="open-hour">
          {t("book.openHour")}
        </button>
      )}
      <HowThisWorks text={t("book.how")} />
    </form>
  );
}
