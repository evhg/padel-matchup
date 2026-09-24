"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addCategoryAction, checkInAction, deskEnterAction, removeCategoryAction, setCompetitionStatusAction, setPairPaidAction, setPairSeedAction, withdrawPairAction } from "@/actions/competitions";
import { bandLabel } from "@/lib/tournamentText";

export type PairRow = { id: string; p1: string; p2: string; paid: boolean; claimed: boolean; position: number; seed: number | null; wildcard: boolean; checkedIn: boolean };
export type CategoryRow = { id: string; name: string; levelMin: number | null; levelMax: number | null; maxPairs: number; drawStatus: string; entered: PairRow[]; waiting: PairRow[] };

const LEVELS = Array.from({ length: 15 }, (_, i) => i * 0.5);
const SIZES = [8, 12, 16, 24, 32, 48, 64];

/**
 * The organiser's desk: open or close entries, the categories with their fields, every pair
 * with its paid mark and a way out, and a pair added by two names for whoever walks up.
 */
export function ManagePanel({ slug, status, categories }: { slug: string; status: "open" | "closed"; categories: CategoryRow[] }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [cat, setCat] = useState({ name: "", levelMin: "", levelMax: "", maxPairs: "16" });
  const [desk, setDesk] = useState<{ categoryId: string; p1: string; p2: string }>({ categoryId: categories[0]?.id ?? "", p1: "", p2: "" });
  const act = (fn: () => Promise<{ ok: boolean; error?: string; detail?: string }>) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) setError(r.error === "invalid" && r.detail === "has_pairs" ? t("tournament.removeBlocked") : r.error === "already_in" ? t("tournament.errAlreadyIn", { who: r.detail === "partner" ? t("tournament.player2") : t("tournament.player1") }) : r.error === "too_many" ? t("tournament.errTooMany", { who: r.detail === "partner" ? t("tournament.player2") : t("tournament.player1"), n: 2 }) : r.error === "invalid" && r.detail === "same_player" ? t("tournament.errSame") : t("common.somethingWrong"));
      router.refresh();
    });
  };

  return (
    <>
      <section className="card flex flex-wrap items-center gap-3" data-testid="manage-status">
        <span className={`chip-muted ${status === "open" ? "text-ok" : ""}`}>{status === "open" ? t("tournament.statusOpen") : t("tournament.statusClosed")}</span>
        <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => act(() => setCompetitionStatusAction(slug, status === "open" ? "closed" : "open"))}>
          {status === "open" ? t("tournament.closeEntries") : t("tournament.openEntries")}
        </button>
        {error && <p className="w-full text-sm font-semibold text-warn">{error}</p>}
      </section>

      {categories.map((c) => (
        <section key={c.id} className="card" data-testid={`manage-category-${c.id}`}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-extrabold">{c.name}</h2>
              <div className="mt-1 flex flex-wrap gap-2 text-sm">
                {bandLabel(c.levelMin, c.levelMax) && <span className="chip-muted">{bandLabel(c.levelMin, c.levelMax)}</span>}
                <span className="chip-muted">{t("tournament.pairsOf", { count: c.entered.length, max: c.maxPairs })}</span>
                {c.waiting.length > 0 && <span className="chip-muted">{t("tournament.waiting")}: {c.waiting.length}</span>}
              </div>
            </div>
            {c.entered.length + c.waiting.length === 0 && (
              <button type="button" className="btn-ghost btn-sm shrink-0" disabled={pending} onClick={() => act(() => removeCategoryAction(slug, c.id))}>
                {t("common.remove")}
              </button>
            )}
          </div>
          {[...c.entered, ...c.waiting].length > 0 && (
            <ul className="mt-3 flex flex-col divide-y divide-line">
              {[...c.entered.map((p) => ({ ...p, waiting: false })), ...c.waiting.map((p) => ({ ...p, waiting: true }))].map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                  {/*
                    One line of names, one row of small buttons. The rehearsal of 24 September 2026 had
                    23 pairs at about 130 pixels each: eight phone screens before the draw's settings.
                    Paid and checked in read off the buttons themselves, in green.
                  */}
                  <div className="min-w-0 flex-1 basis-40 truncate font-semibold">
                    {p.waiting ? `⏳ ` : ""}
                    {p.p1} & {p.p2}
                    {!p.claimed && <span className="ml-1 text-xs font-normal text-faint">({t("tournament.unclaimed")})</span>}
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {c.drawStatus === "none" && (
                      <label className="flex items-center gap-1 text-xs font-bold">
                        {t("tournament.seed")}
                        <select className="input min-h-9 w-14 px-2 py-0 text-xs" value={p.seed ?? ""} disabled={pending} aria-label={`${t("tournament.seed")} ${p.p1}`} onChange={(e) => act(() => setPairSeedAction(slug, p.id, e.target.value === "" ? null : Number(e.target.value)))}>
                          <option value="">—</option>
                          {Array.from({ length: Math.min(16, c.maxPairs) }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>
                              {n}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <button type="button" className={`btn-ghost btn-xs ${p.paid ? "text-ok" : ""}`} disabled={pending} onClick={() => act(() => setPairPaidAction(slug, p.id, !p.paid))}>
                      {p.paid ? (
                        <>
                          ✓ <span>{t("tournament.paid")}</span>
                        </>
                      ) : (
                        t("tournament.markPaid")
                      )}
                    </button>
                    {c.drawStatus !== "none" && (
                      <button type="button" className={`btn-ghost btn-xs ${p.checkedIn ? "text-ok" : ""}`} disabled={pending} data-testid={`checkin-${p.id}`} onClick={() => act(() => checkInAction(slug, p.id, !p.checkedIn))}>
                        {p.checkedIn ? `✓ ${t("tournament.checkedIn")}` : t("tournament.checkIn")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost btn-xs text-muted"
                      disabled={pending}
                      onClick={() => {
                        if (confirm(t("tournament.withdrawConfirm"))) act(() => withdrawPairAction(slug, p.id));
                      }}
                    >
                      {t("tournament.withdraw")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      ))}

      <form
        className="card flex flex-col gap-3"
        data-testid="add-category"
        onSubmit={(e) => {
          e.preventDefault();
          act(async () => {
            const r = await addCategoryAction(slug, { name: cat.name, levelMin: cat.levelMin === "" ? null : Number(cat.levelMin), levelMax: cat.levelMax === "" ? null : Number(cat.levelMax), maxPairs: Number(cat.maxPairs) });
            if (r.ok) setCat({ name: "", levelMin: "", levelMax: "", maxPairs: "16" });
            return r;
          });
        }}
      >
        <h2 className="text-lg font-extrabold">{t("tournament.addCategory")}</h2>
        <div>
          <label className="block">
            <span className="text-sm font-bold">{t("tournament.categoryName")}</span>
            <input className="input mt-1" value={cat.name} maxLength={40} required onChange={(e) => setCat({ ...cat, name: e.target.value })} />
          </label>
          <span className="mt-1 block text-xs text-muted">{t("tournament.categoryNameHelp")}</span>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="text-sm font-bold">{t("tournament.levelFrom")}</span>
            <select className="input mt-1" value={cat.levelMin} onChange={(e) => setCat({ ...cat, levelMin: e.target.value })}>
              <option value="">{t("tournament.levelAny")}</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l.toFixed(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-bold">{t("tournament.levelTo")}</span>
            <select className="input mt-1" value={cat.levelMax} onChange={(e) => setCat({ ...cat, levelMax: e.target.value })}>
              <option value="">{t("tournament.levelAny")}</option>
              {LEVELS.map((l) => (
                <option key={l} value={l}>
                  {l.toFixed(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-sm font-bold">{t("tournament.maxPairs")}</span>
            <select className="input mt-1" value={cat.maxPairs} onChange={(e) => setCat({ ...cat, maxPairs: e.target.value })}>
              {SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <span className="text-xs text-muted">{t("tournament.maxPairsHelp")}</span>
        <button type="submit" className="btn-primary btn-sm self-start" disabled={pending}>
          {t("tournament.add")}
        </button>
      </form>

      {categories.length > 0 && (
        <form
          className="card flex flex-col gap-3"
          data-testid="desk-entry"
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              const r = await deskEnterAction(slug, desk.categoryId || categories[0].id, { p1: desk.p1, p2: desk.p2 });
              if (r.ok) setDesk({ ...desk, p1: "", p2: "" });
              return r;
            });
          }}
        >
          <h2 className="text-lg font-extrabold">{t("tournament.addPair")}</h2>
          <label className="block">
            <span className="text-sm font-bold">{t("tournament.categoryName")}</span>
            <select className="input mt-1" value={desk.categoryId || categories[0].id} onChange={(e) => setDesk({ ...desk, categoryId: e.target.value })}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-bold">{t("tournament.player1")}</span>
              <input className="input mt-1" value={desk.p1} maxLength={40} required onChange={(e) => setDesk({ ...desk, p1: e.target.value })} />
            </label>
            <label className="block">
              <span className="text-sm font-bold">{t("tournament.player2")}</span>
              <input className="input mt-1" value={desk.p2} maxLength={40} required onChange={(e) => setDesk({ ...desk, p2: e.target.value })} />
            </label>
          </div>
          <button type="submit" className="btn-primary btn-sm self-start" disabled={pending}>
            {t("tournament.add")}
          </button>
        </form>
      )}
    </>
  );
}
