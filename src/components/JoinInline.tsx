"use client";

import { useTranslations } from "next-intl";
import { startTransition, useEffect, useRef, useState, useTransition } from "react";
import { joinAction } from "@/actions/slots";
import { registerJoinHandler } from "./joinBus";

/** In-flow name entry for joining the waitlist without an identity (no open rows to expand). */
export function JoinInline({ code, label }: { code: string; label: string }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
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
  return (
    <form
      ref={box}
      className="mt-4 rounded-2xl border border-court/30 bg-court-soft/40 p-3 animate-pop"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return setError(t("identity.nameRequired"));
        start(async () => {
          setError(null);
          const r = await joinAction(code, name);
          startTransition(() => {
            if (!r.ok) setError(t(`errors.${r.error === "name_required" || r.error === "no_identity" ? "generic" : r.error}` as "errors.generic"));
          });
        });
      }}
    >
      <div className="text-sm font-bold text-court">{t("identity.whatsYourName")}</div>
      <div className="mt-2 flex gap-2">
        <input ref={input} className="input" placeholder={t("identity.namePlaceholder")} value={name} autoComplete="given-name" maxLength={40} enterKeyHint="go" onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn-primary shrink-0" disabled={pending}>
          {pending ? t("common.working") : label}
        </button>
      </div>
      {error ? <p className="mt-1 text-sm font-semibold text-danger">{error}</p> : <p className="mt-1 text-xs text-faint">{t("identity.nameHelp")}</p>}
    </form>
  );
}
