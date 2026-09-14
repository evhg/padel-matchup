"use client";

import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { claimPaidAction, setPaidAction } from "@/actions/slots";

export type PaymentRow = { slotId: string; playerId: string; name: string; claimed: boolean; paid: boolean };

/**
 * Who has paid, for a match that names a cost. No money passes through Kicksmash: a player says the
 * money is sent, the organiser says it arrived, and those are two different claims by two different
 * people. Everyone sees the same list, so nobody has to ask in the chat who is still owing.
 */
export function MatchPayments({ code, cost, rows, isOrganiser, mePlayerId }: { code: string; cost: string; rows: PaymentRow[]; isOrganiser: boolean; mePlayerId: string | null }) {
  const t = useTranslations("event");
  const [pending, start] = useTransition();
  const mine = rows.find((r) => r.playerId === mePlayerId);
  const owing = rows.filter((r) => !r.paid).length;

  return (
    <section className="card flex flex-col gap-3" data-testid="payments">
      <div>
        <h2 className="text-lg font-extrabold">💸 {t("paidTitle")}</h2>
        <p className="mt-0.5 text-xs text-muted">{owing === 0 ? t("paidAll") : t("paidOwing", { n: owing, cost })}</p>
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <li key={r.slotId} className="flex items-center justify-between gap-3 text-sm">
            <span className={r.paid ? "font-bold" : ""}>{r.name}</span>
            {isOrganiser ? (
              <button
                type="button"
                className={r.paid ? "chip-open" : "chip-muted"}
                disabled={pending}
                data-testid={`paid-${r.slotId}`}
                onClick={() => start(async () => void (await setPaidAction(code, r.slotId, !r.paid)))}
              >
                {r.paid ? t("paidYes") : r.claimed ? t("paidClaimed") : t("paidNot")}
              </button>
            ) : (
              <span className={r.paid ? "chip-open" : "chip-muted"}>{r.paid ? t("paidYes") : r.claimed ? t("paidClaimed") : t("paidNot")}</span>
            )}
          </li>
        ))}
      </ul>
      {mine && !mine.paid && !mine.claimed && (
        <button type="button" className="btn-secondary" disabled={pending} data-testid="claim-paid" onClick={() => start(async () => void (await claimPaidAction(code)))}>
          {pending ? "…" : t("paidClaim")}
        </button>
      )}
      <p className="text-xs text-faint">{t("paidNothingThrough")}</p>
    </section>
  );
}
