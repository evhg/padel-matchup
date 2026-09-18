"use client";

import { useTranslations } from "next-intl";
import type { OfferInput } from "@/lib/domain/coaching";

type Props = {
  value: OfferInput[];
  onChange: (next: OfferInput[]) => void;
  /** The lengths this coach sells: their usual one and the second, when set. */
  lengths: number[];
  currency: string;
  max?: number;
};

/**
 * The packages on a coach's page, edited as rows: how many lessons, how long, for how many on court,
 * what each pays, and how long it stays valid. Benji's card has two of these (ten of sixty minutes,
 * for one or for a pair); three is the ceiling, because a fourth is a price list nobody reads on a
 * phone. The same rows in the setup walk and in settings, so a coach learns one thing.
 */
export function OffersEditor({ value, onChange, lengths, currency, max = 3 }: Props) {
  const t = useTranslations("coach");
  const set = (i: number, patch: Partial<OfferInput>) => onChange(value.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  const num = (v: string) => Number(v.replace(/[^\d]/g, "")) || 0;
  const add = () => onChange([...value, { size: 10, minutes: lengths[0] ?? 60, heads: 1, price: 0, validDays: 70 }]);
  return (
    <div className="flex flex-col gap-3" data-testid="offers-editor">
      {value.map((o, i) => (
        <div key={o.id ?? `new-${i}`} className="rounded-2xl border border-line bg-white p-3" data-testid={`offer-${i}`}>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-xs font-bold text-muted">
              {t("setup.offerLessons")}
              <input type="number" min={1} max={200} className="input mt-1" value={o.size || ""} onChange={(e) => set(i, { size: num(e.target.value) })} data-testid={`offer-size-${i}`} />
            </label>
            <label className="block text-xs font-bold text-muted">
              {t("setup.offerLength")}
              <select className="input mt-1" value={o.minutes} onChange={(e) => set(i, { minutes: Number(e.target.value) })} data-testid={`offer-minutes-${i}`}>
                {lengths.map((m) => (
                  <option key={m} value={m}>
                    {t("minutes", { n: m })}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-bold text-muted">
              {t("setup.offerFor")}
              <select className="input mt-1" value={o.heads} onChange={(e) => set(i, { heads: Number(e.target.value) })} data-testid={`offer-heads-${i}`}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {t("setup.persons", { n })}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-bold text-muted">
              {t("setup.offerPrice")} ({currency})
              <input inputMode="numeric" className="input mt-1" value={o.price || ""} onChange={(e) => set(i, { price: num(e.target.value) })} placeholder="25200" data-testid={`offer-price-${i}`} />
            </label>
            <label className="block text-xs font-bold text-muted">
              {t("setup.offerValid")}
              <input type="number" min={0} max={730} className="input mt-1" value={o.validDays ?? ""} onChange={(e) => set(i, { validDays: e.target.value.trim() === "" ? null : num(e.target.value) })} data-testid={`offer-valid-${i}`} />
            </label>
            <div className="flex items-end">
              <button type="button" className="btn-ghost btn-sm w-full" onClick={() => onChange(value.filter((_, j) => j !== i))} data-testid={`offer-remove-${i}`}>
                {t("setup.offerRemove")}
              </button>
            </div>
          </div>
          {/* A coach thinks in what the pair pays at the desk; the book keeps what each person pays. Both are on screen. */}
          {o.heads > 1 && o.price > 0 && <p className="mt-2 text-xs text-muted">{t("setup.together", { amount: `${o.price * o.heads} ${currency}`, n: o.heads })}</p>}
        </div>
      ))}
      {value.length < max && (
        <button type="button" className="btn-ghost btn-sm self-start" onClick={add} data-testid="offer-add">
          ＋ {t("setup.offerAdd")}
        </button>
      )}
    </div>
  );
}
