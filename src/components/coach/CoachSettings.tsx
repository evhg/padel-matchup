"use client";

import { useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { removeQrAction, saveCoachSettingsAction, uploadQrAction, type SettingsInput } from "@/actions/coach";
import { LESSON_MINUTES, QR_UPLOAD_MAX_BYTES } from "@/lib/domain/coaching";
import { HowThisWorks } from "./HowThisWorks";
import { PromptPayQr } from "./PromptPayQr";

type Props = { initial: SettingsInput; hasQr: boolean; qrUrl: string | null };

const weekdayNames = (locale: string) => Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 7 + i))));

/** One form, saved with one button. Words over widgets: hours are typed the way a coach says them. */
export function CoachSettings({ initial, hasQr, qrUrl }: Props) {
  const t = useTranslations("coach");
  const locale = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [v, setV] = useState<SettingsInput>(initial);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const days = weekdayNames(locale);
  const order = [1, 2, 3, 4, 5, 6, 0];

  const set = <K extends keyof SettingsInput>(k: K, val: SettingsInput[K]) => setV((s) => ({ ...s, [k]: val }));

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setSaved(false);
    setError(null);
    start(async () => {
      const r = await saveCoachSettingsAction(v);
      if (!r.ok) {
        setError(r.error === "invalid" && r.detail && /^\d$/.test(r.detail) ? t("settings.invalidHours", { day: days[Number(r.detail)] }) : t("errors.no_coach"));
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    if (file.size > QR_UPLOAD_MAX_BYTES) {
      setError(t("settings.qrTooBig"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () =>
      start(async () => {
        const r = await uploadQrAction(String(reader.result));
        if (!r.ok) setError(t("settings.qrTooBig"));
        router.refresh();
      });
    reader.readAsDataURL(file);
  };

  return (
    <form onSubmit={save} className="flex flex-col gap-4">
      <section className="card flex flex-col gap-4">
        <h1 className="text-3xl font-extrabold tracking-tight">{t("settings.title")}</h1>
        <label className="block text-sm font-bold">
          {t("settings.name")}
          <input className="input mt-1" value={v.displayName} onChange={(e) => set("displayName", e.target.value)} maxLength={40} />
        </label>
        <label className="block text-sm font-bold">
          {t("settings.clubs")}
          <input className="input mt-1" value={v.clubs} onChange={(e) => set("clubs", e.target.value)} placeholder={t("setup.clubPlaceholder")} maxLength={200} />
        </label>
        <label className="block text-sm font-bold">
          {t("settings.length")}
          <select className="input mt-1" value={v.lessonMinutes} onChange={(e) => set("lessonMinutes", Number(e.target.value))}>
            {LESSON_MINUTES.map((m) => (
              <option key={m} value={m}>
                {t("minutes", { n: m })}
              </option>
            ))}
          </select>
        </label>
        <div>
          <div className="text-sm font-bold">{t("settings.hours")}</div>
          <p className="text-xs text-muted">{t("settings.hoursHelp")}</p>
          <div className="mt-2 grid grid-cols-[6rem_1fr] items-center gap-2">
            {order.map((d) => (
              <FragmentRow key={d} label={days[d]} value={v.hoursLines[d] ?? ""} onChange={(val) => set("hoursLines", v.hoursLines.map((x, i) => (i === d ? val : x)))} />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="block text-xs font-bold text-muted">
            {t("settings.cutoff")}
            <input type="number" min={0} max={72} className="input mt-1" value={v.cutoffHours} onChange={(e) => set("cutoffHours", Number(e.target.value))} />
          </label>
          <label className="block text-xs font-bold text-muted">
            {t("settings.passes")}
            <input type="number" min={0} max={5} className="input mt-1" value={v.latePasses} onChange={(e) => set("latePasses", Number(e.target.value))} />
          </label>
          <label className="block text-xs font-bold text-muted">
            {t("settings.notice")}
            <input type="number" min={0} max={48} className="input mt-1" value={v.minNoticeHours} onChange={(e) => set("minNoticeHours", Number(e.target.value))} />
          </label>
        </div>
      </section>

      <section className="card flex flex-col gap-4">
        <label className="block text-sm font-bold">
          {t("settings.promptpay")}
          <input className="input mt-1" value={v.promptpayId} onChange={(e) => set("promptpayId", e.target.value)} inputMode="tel" placeholder="08x xxx xxxx" maxLength={20} />
          <span className="mt-1 block text-xs font-normal text-muted">{t("settings.promptpayHelp")}</span>
        </label>
        {v.promptpayId && !hasQr && (
          <div>
            <PromptPayQr promptpayId={v.promptpayId} amount={null} size={120} />
          </div>
        )}
        <label className="block text-sm font-bold">
          {t("settings.payLink")}
          <input className="input mt-1" value={v.payLink} onChange={(e) => set("payLink", e.target.value)} inputMode="url" placeholder="https://" maxLength={200} />
        </label>
        <div>
          <div className="text-sm font-bold">{t("settings.qr")}</div>
          {hasQr && qrUrl ? (
            <div className="mt-2 flex items-center gap-3">
              <PromptPayQr imageUrl={qrUrl} size={96} />
              <div className="text-xs text-muted">
                {t("settings.qrUploaded")}
                <button type="button" className="ml-2 font-bold text-ink underline underline-offset-4" onClick={() =>
                    start(async () => {
                      await removeQrAction();
                      router.refresh();
                    })
                  }>
                  {t("settings.qrRemove")}
                </button>
              </div>
            </div>
          ) : (
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="mt-2 block text-sm" onChange={(e) => upload(e.target.files?.[0])} />
          )}
        </div>
        <label className="block text-sm font-bold">
          {t("settings.whatsapp")}
          <input className="input mt-1" value={v.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} inputMode="tel" placeholder="+66…" maxLength={20} />
          <span className="mt-1 block text-xs font-normal text-muted">{t("settings.whatsappHelp")}</span>
        </label>
        <label className="flex items-center gap-2 text-sm font-bold">
          <input type="checkbox" checked={v.isPublic} onChange={(e) => set("isPublic", e.target.checked)} /> {t("settings.public")}
          <span className="text-xs font-normal text-muted">{t("settings.publicHelp")}</span>
        </label>
        <label className="block text-sm font-bold">
          {t("settings.tz")}
          <input className="input mt-1" value={v.tz} onChange={(e) => set("tz", e.target.value)} maxLength={60} />
        </label>
      </section>

      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      {saved && <p className="text-sm font-semibold text-ok">✓ {t("settings.saved")}</p>}
      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? "…" : t("settings.save")}
      </button>
      <HowThisWorks text={t("settings.how")} />
    </form>
  );
}

function FragmentRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <>
      <label className="truncate text-sm font-bold" htmlFor={`hours-${label}`}>
        {label}
      </label>
      <input id={`hours-${label}`} className="input" value={value} onChange={(e) => onChange(e.target.value)} placeholder="07:00-12:00, 15:00-20:00" />
    </>
  );
}
