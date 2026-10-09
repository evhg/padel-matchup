"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { setMyLevelAction } from "@/actions/identity";
import { QUICK_BANDS, bandLevel, levelAskSkipKey } from "@/lib/domain/levelAsk";
import { formatLevel, fromScale, scaleById } from "@/lib/domain/levels";

/**
 * "Your level?" under the join confirmation, for a player who has none (src/lib/domain/levelAsk.ts
 * decides when). One tap saves it through the same action as My matches, so it is self-declared
 * like any other; the page then renders without the card and with the chip on the roster row.
 *
 * Skip is this device's answer for this player, kept in localStorage. Storage can be missing (a
 * private window, blocked site data), so every read and write is wrapped and the card simply shows.
 * It starts hidden until the device has been asked, so somebody who skipped never sees it flash.
 */
export function LevelAfterJoin({ playerId }: { playerId: string }) {
  const t = useTranslations();
  const [shown, setShown] = useState(false);
  const [playtomic, setPlaytomic] = useState(false);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState(false);
  const [pending, start] = useTransition();
  const key = levelAskSkipKey(playerId);
  const scale = scaleById("playtomic")!;
  const typed = raw.trim() ? fromScale("playtomic", Number(raw.replace(",", "."))) : null;

  useEffect(() => {
    let skipped = false;
    try {
      skipped = localStorage.getItem(key) === "1";
    } catch {
      /* storage unavailable: ask */
    }
    setShown(!skipped);
  }, [key]);

  if (!shown) return null;

  const save = (level: number) =>
    start(async () => {
      setError(false);
      const r = await setMyLevelAction(level);
      if (r.ok) setShown(false);
      else setError(true);
    });
  const skip = () => {
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* storage unavailable: hidden for this visit only */
    }
    setShown(false);
  };

  return (
    <div className="mt-3 rounded-2xl border border-line px-4 py-3" data-testid="level-after-join">
      <div className="font-bold">{t("level.joinedTitle")}</div>
      <p className="mt-0.5 text-sm text-muted">{t("level.joinedHelp")}</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {QUICK_BANDS.map((b) => (
          <button key={b} type="button" className="btn-secondary btn-sm" disabled={pending} title={t(`level.bandHelp.${b}`)} onClick={() => save(bandLevel(b))}>
            {t(`level.bands.${b}`)}
          </button>
        ))}
      </div>
      {playtomic ? (
        <form
          className="mt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (typed != null) save(typed);
          }}
        >
          <p className="text-xs text-faint">{t("level.joinedPlaytomicHelp")}</p>
          <div className="mt-1 flex gap-2">
            <input
              className="input"
              aria-label={t("passport.scale.playtomic")}
              inputMode="decimal"
              type="number"
              min={scale.min}
              max={scale.max}
              step={scale.step}
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn-primary shrink-0" disabled={pending || typed == null}>
              {pending ? t("common.saving") : typed != null ? t("passport.importUse", { level: formatLevel(typed) }) : t("common.save")}
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="mt-2 text-sm link" onClick={() => setPlaytomic(true)}>
          {t("level.joinedPlaytomic")}
        </button>
      )}
      <div className="mt-2 flex items-center justify-between gap-2">
        {error ? <span className="text-sm font-semibold text-danger">{t("common.somethingWrong")}</span> : <span />}
        <button type="button" className="text-sm text-muted underline" disabled={pending} onClick={skip}>
          {t("level.joinedSkip")}
        </button>
      </div>
    </div>
  );
}
