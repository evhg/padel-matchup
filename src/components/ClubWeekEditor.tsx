"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { addClubSlotAction, removeClubSlotAction, setClubSlotActiveAction, updateClubSlotAction, type ClubSlotInput } from "@/actions/clubWeek";
import { MATCH_CAPACITY, MAX_TOURNAMENT_CAPACITY } from "@/lib/config";
import { AGE_MINS, CATEGORY_KEYS, EVENT_CATEGORIES, type AgeMin, type EventCategory } from "@/lib/domain/eventTags";
import { LEVEL_PRESETS, type PresetKey } from "@/lib/domain/levels";
import { rangeChip } from "@/lib/levelText";

export type EditorSlot = { id: string; dow: number; time: string; type: string; format: string | null; capacity: number; levelMin: number | null; levelMax: number | null; verifiedOnly: boolean; category: string | null; ageMin: number | null; title: string | null; active: boolean; leadDays: number; next: { code: string; startsAt: string } | null };

const KINDS = [
  { key: "match", type: "match" as const, format: null, capacity: MATCH_CAPACITY },
  { key: "americano", type: "tournament" as const, format: "americano" as const, capacity: 8 },
  { key: "mexicano", type: "tournament" as const, format: "mexicano" as const, capacity: 8 },
  { key: "king", type: "tournament" as const, format: "king" as const, capacity: 8 },
] as const;

type TagPick = { category?: EventCategory | null; ageMin?: AgeMin | null };

/**
 * Who a slot's matches are for: the question in words, then the two rows of chips. The same on the
 * add form and on every slot's line, where one tap retags the slot and its coming match in place.
 */
function TagChoice({ category, ageMin, onPick, chip, disabled, testId }: { category: string | null; ageMin: number | null; onPick: (p: TagPick) => void; chip: (on: boolean) => string; disabled?: boolean; testId: string }) {
  const t = useTranslations();
  const label = useId();
  return (
    <div role="group" aria-labelledby={label}>
      <div id={label} className="text-xs font-bold">
        {t("level.tagLabel")}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-2" role="radiogroup" aria-labelledby={label} data-testid={`${testId}-category`}>
        {([null, ...EVENT_CATEGORIES] as const).map((c) => (
          <button key={c ?? "anyone"} type="button" role="radio" aria-checked={category === c} disabled={disabled} className={chip(category === c)} onClick={() => onPick({ category: c })}>
            {c ? t(CATEGORY_KEYS[c]) : t("level.tagAnyone")}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2" role="radiogroup" aria-label={t("level.tagAgeLabel")} data-testid={`${testId}-age`}>
        {([null, ...AGE_MINS] as const).map((a) => (
          <button key={a ?? "any"} type="button" role="radio" aria-checked={ageMin === a} disabled={disabled} className={chip(ageMin === a)} onClick={() => onPick({ ageMin: a })}>
            {a ? t("level.tagAge", { age: a }) : t("level.tagAnyAge")}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The club's week: one line per repeating slot, one small form to add another. Nothing here needs the club again once saved. */
export function ClubWeekEditor({ token, slots, leadDays }: { token: string; slots: EditorSlot[]; leadDays: number }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [dow, setDow] = useState(6);
  const [time, setTime] = useState("18:00");
  const [kind, setKind] = useState<(typeof KINDS)[number]["key"]>("americano");
  const [capacityText, setCapacityText] = useState("8");
  const [preset, setPreset] = useState<PresetKey | "any">("any");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  // Who the slot's matches are for (the owner's decision of 9 October 2026, G1): a weekly "Ladies social" is "Women" on every one.
  const [category, setCategory] = useState<EventCategory | null>(null);
  const [ageMin, setAgeMin] = useState<AgeMin | null>(null);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const weekday = (d: number, style: "short" | "long" = "short") => new Intl.DateTimeFormat(locale, { weekday: style, timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + d, 12)));
  const kindLabel = (type: string, format: string | null) => t(`club.week.kind.${type === "tournament" ? (format ?? "americano") : "match"}` as "club.week.kind.match");
  const chip = (active: boolean) => `rounded-full border px-3 py-1.5 text-sm font-bold transition ${active ? "border-ink bg-ink text-on-ink" : "border-line bg-card text-ink hover:border-ink/40"}`;
  const smallChip = (active: boolean) => `rounded-full border px-2.5 py-1 text-xs font-bold transition ${active ? "border-ink bg-ink text-on-ink" : "border-line bg-card text-ink hover:border-ink/40"}`;

  // Fours within the tournament bounds; typed freely, settled when the field is left or the form sent.
  const clampCapacity = (raw: string, fallback: number) => {
    const n = Number(raw);
    if (!Number.isFinite(n) || raw.trim() === "") return fallback;
    return Math.max(MATCH_CAPACITY, Math.min(MAX_TOURNAMENT_CAPACITY, Math.round(n / 4) * 4 || MATCH_CAPACITY));
  };
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    const k = KINDS.find((x) => x.key === kind)!;
    const range = preset === "any" ? null : LEVEL_PRESETS.find((p) => p.key === preset)!;
    const capacity = k.type === "match" ? MATCH_CAPACITY : clampCapacity(capacityText, k.capacity);
    setCapacityText(String(capacity));
    const input: ClubSlotInput = { dow, time, type: k.type, format: k.format, capacity, levelMin: range?.min ?? null, levelMax: range?.max ?? null, verifiedOnly: Boolean(range) && verifiedOnly, category, ageMin, title: title.trim() || undefined, leadDays };
    start(async () => {
      setError(null);
      const r = await addClubSlotAction(token, input);
      if (!r.ok) {
        setError(t("common.somethingWrong"));
        return;
      }
      setNote(t("club.week.added", { days: leadDays }));
      setTitle("");
      router.refresh();
    });
  };
  // A slot's own tag, changed in place: the slot keeps what it already made, and its coming match follows.
  const retag = (s: EditorSlot, p: TagPick) =>
    start(async () => {
      setError(null);
      const r = await updateClubSlotAction(token, s.id, p);
      if (!r.ok) setError(t("common.somethingWrong"));
      router.refresh();
    });
  const toggle = (s: EditorSlot) =>
    start(async () => {
      setError(null);
      const r = await setClubSlotActiveAction(token, s.id, !s.active);
      if (!r.ok) setError(t("common.somethingWrong"));
      router.refresh();
    });
  const remove = (s: EditorSlot) => {
    if (!confirm(t("club.week.removeConfirm"))) return;
    start(async () => {
      setError(null);
      const r = await removeClubSlotAction(token, s.id);
      if (!r.ok) setError(t("common.somethingWrong"));
      router.refresh();
    });
  };

  return (
    <section className="card" id="week" data-testid="club-week-editor">
      <h2 className="text-lg font-extrabold">{t("club.week.editorTitle")}</h2>
      <p className="mt-1 text-sm text-muted">{t("club.week.editorHelp", { days: leadDays })}</p>
      {slots.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" data-testid="club-slots">
          {slots.map((s) => {
            const level = rangeChip(t, { min: s.levelMin, max: s.levelMax });
            return (
              <li key={s.id} className="rounded-2xl border border-line bg-card px-4 py-2" data-testid="club-slot">
                <div className="flex items-center gap-3">
                  {/* A paused slot dims its words, never its buttons: Resume and the chips must not look disabled. */}
                  <div className={`w-16 shrink-0 ${s.active ? "" : "opacity-60"}`}>
                    <div className="text-xs font-bold uppercase text-faint">{weekday(s.dow)}</div>
                    <div className="text-lg font-extrabold leading-none tabular-nums">{s.time}</div>
                  </div>
                  <div className={`min-w-0 flex-1 ${s.active ? "" : "opacity-60"}`}>
                    <div className="truncate font-bold">
                      {s.title || kindLabel(s.type, s.format)}
                      {s.title && <span className="font-normal text-muted"> · {kindLabel(s.type, s.format)}</span>}
                    </div>
                    <div className="truncate text-xs text-muted">
                      {t("club.week.players", { count: s.capacity })}
                      {level ? ` · ${level}` : ""}
                      {s.verifiedOnly ? ` · ✓ ${t("levelCheck.chip")}` : ""}
                      {!s.active ? ` · ${t("club.week.paused")}` : s.next ? ` · ${t("club.week.nextUp", { code: s.next.code })}` : ""}
                    </div>
                  </div>
                  <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => toggle(s)}>
                    {s.active ? t("club.week.pause") : t("club.week.resume")}
                  </button>
                  <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => remove(s)} aria-label={t("club.week.remove")}>
                    ✕
                  </button>
                </div>
                <div className="mt-2 border-t border-line pt-2">
                  <TagChoice category={s.category} ageMin={s.ageMin} chip={smallChip} disabled={pending} testId="slot-row" onPick={(p) => retag(s, p)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <form onSubmit={add} className="mt-4 flex flex-col gap-3 rounded-2xl bg-bg p-4">
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("club.week.weekday")}>
          {[1, 2, 3, 4, 5, 6, 0].map((d) => (
            <button key={d} type="button" role="radio" aria-checked={dow === d} className={chip(dow === d)} onClick={() => setDow(d)}>
              {weekday(d)}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="text-xs font-bold">{t("club.week.time")}</span>
            <input className="input mt-1" type="time" value={time} onChange={(e) => setTime(e.target.value)} required data-testid="slot-time" />
          </label>
          <label className="block">
            <span className="text-xs font-bold">{t("club.week.capacity")}</span>
            <input
              className="input mt-1"
              type="number"
              min={MATCH_CAPACITY}
              max={MAX_TOURNAMENT_CAPACITY}
              step={4}
              inputMode="numeric"
              value={kind === "match" ? MATCH_CAPACITY : capacityText}
              disabled={kind === "match"}
              onChange={(e) => setCapacityText(e.target.value)}
              onBlur={() => setCapacityText(String(clampCapacity(capacityText, KINDS.find((x) => x.key === kind)!.capacity)))}
              data-testid="slot-capacity"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("club.week.format")}>
          {KINDS.map((k) => (
            <button
              key={k.key}
              type="button"
              role="radio"
              aria-checked={kind === k.key}
              className={chip(kind === k.key)}
              onClick={() => {
                setKind(k.key);
                setCapacityText(String(k.capacity));
              }}
            >
              {kindLabel(k.type, k.format)}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t("club.week.levelLabel")}>
          <button type="button" role="radio" aria-checked={preset === "any"} className={chip(preset === "any")} onClick={() => setPreset("any")}>
            {t("level.any")}
          </button>
          {LEVEL_PRESETS.map((p) => (
            <button key={p.key} type="button" role="radio" aria-checked={preset === p.key} className={chip(preset === p.key)} onClick={() => setPreset(p.key)}>
              {t(`level.${p.key}`)} {p.min}–{p.max}
            </button>
          ))}
        </div>
        {preset !== "any" && (
          <label className="flex cursor-pointer items-start gap-3 rounded-2xl bg-card px-4 py-3">
            <input type="checkbox" className="mt-1 h-5 w-5 accent-ink" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} data-testid="slot-verified-only" />
            <span className="min-w-0">
              <span className="block text-sm font-bold">✓ {t("levelCheck.verifiedOnly")}</span>
              <span className="block text-xs text-muted">{t("levelCheck.verifiedOnlyHelp")}</span>
            </span>
          </label>
        )}
        <div>
          <TagChoice
            category={category}
            ageMin={ageMin}
            chip={chip}
            testId="slot"
            onPick={(p) => {
              if (p.category !== undefined) setCategory(p.category);
              if (p.ageMin !== undefined) setAgeMin(p.ageMin);
            }}
          />
          <p className="mt-1.5 text-xs text-muted">{t("level.tagHelp")}</p>
        </div>
        <label className="block">
          <span className="text-xs font-bold">{t("club.week.titleLabel")}</span>
          <input className="input mt-1" value={title} maxLength={80} placeholder={t("club.week.titlePlaceholder")} onChange={(e) => setTitle(e.target.value)} data-testid="slot-title" />
        </label>
        <button type="submit" className="btn-primary w-full" disabled={pending} data-testid="slot-add">
          {pending ? t("common.working") : t("club.week.add")}
        </button>
        {note && <p className="text-sm font-semibold text-ok">{note}</p>}
        {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      </form>
    </section>
  );
}
