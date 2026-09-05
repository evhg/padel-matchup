"use client";

import { useTranslations } from "next-intl";
import { startTransition, useEffect, useRef, useState, useTransition } from "react";
import { joinAction } from "@/actions/slots";
import type { LevelRange } from "@/lib/domain/levels";
import { registerJoinHandler } from "./joinBus";
import { LevelSelect } from "./LevelSelect";

/** In-flow name (and level, on ranged events) entry for joining the waitlist without an identity. */
export function JoinInline({ code, label, hasIdentity = false, levelRange = null, myLevel = null }: { code: string; label: string; hasIdentity?: boolean; levelRange?: LevelRange | null; myLevel?: number | null }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [level, setLevel] = useState<number | null>(myLevel);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(
    () =>
      registerJoinHandler(() => {
        setOpen(true);
        requestAnimationFrame(() => {
          box.current?.scrollIntoView({ block: "center", behavior: "smooth" });
          input.current?.focus({ preventScroll: true });
        });
      }),
    [],
  );

  if (!open) return null;
  const askLevel = Boolean(levelRange) && level == null;
  return (
    <form
      ref={box}
      className="mt-4 rounded-2xl border border-court/30 bg-court-soft/40 p-3 animate-pop"
      onSubmit={(e) => {
        e.preventDefault();
        if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
        if (levelRange && level == null) return setError(t("errors.level_required"));
        start(async () => {
          setError(null);
          const r = await joinAction(code, hasIdentity ? undefined : name, level ?? undefined);
          startTransition(() => {
            if (!r.ok) setError(r.error === "level_required" ? t("errors.level_required") : t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
          });
        });
      }}
    >
      <div className="text-sm font-bold text-court">{hasIdentity ? t("level.pickTitle") : t("identity.whatsYourName")}</div>
      <div className="mt-2 flex flex-col gap-2">
        <div className="flex gap-2">
          {!hasIdentity && <input ref={input} className="input" placeholder={t("identity.namePlaceholder")} value={name} autoComplete="given-name" maxLength={40} enterKeyHint="go" onChange={(e) => setName(e.target.value)} />}
          {(askLevel || (levelRange && !hasIdentity)) && <LevelSelect value={level} onChange={setLevel} />}
          <button type="submit" className="btn-primary shrink-0" disabled={pending}>
            {pending ? t("common.working") : label}
          </button>
        </div>
      </div>
      {error ? <p className="mt-1 text-sm font-semibold text-danger">{error}</p> : <p className="mt-1 text-xs text-faint">{levelRange ? t("level.pickHelp") : t("identity.nameHelp")}</p>}
    </form>
  );
}
