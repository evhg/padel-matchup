"use client";

import { useTranslations } from "next-intl";
import { startTransition, useEffect, useRef, useState, useTransition } from "react";
import { thatsMeAction } from "@/actions/identity";
import { requestBackIn } from "./backInBus";

/**
 * Two taps, the owner's pattern for a tap that acts as somebody (10 October 2026): the first arms the
 * button and sends nothing; a tap anywhere else, Escape or leaving the button disarms it. "That's me"
 * and "Take Danny's held place" both stand on it.
 */
export function useTwoTap<T extends HTMLElement>() {
  const [armed, setArmed] = useState(false);
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!armed) return;
    const away = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setArmed(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setArmed(false);
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", escape);
    };
  }, [armed]);
  return { armed, setArmed, ref };
}

/**
 * "That's me" (DECIDING rule 34): two taps sign this browser in as the record of that name, or fold
 * the browser's own new record into it. The first tap only arms the button, which then asks "Sign in
 * as Ana?"; the second sends. A tap anywhere else, Escape or leaving the button disarms it, so a thumb
 * that lands on the row above signs nobody in (the owner, 10 October 2026). The page shows it only
 * where `thatsMeVerdict` already said yes, and the action asks again; when the answer has changed in
 * between, the way back in that needs proof (email code, Telegram) opens instead.
 */
export function ThatsMeButton({
  code,
  name,
  label = name,
  className = "btn-ghost btn-xs shrink-0",
  armedClassName = "btn-primary btn-xs shrink-0 max-w-44 whitespace-normal leading-tight",
}: {
  code: string;
  /** The name the tap sends: the server decides again for exactly this name. */
  name: string;
  /** The name the armed button shows ("Sign in as Tim?"), where it differs from what the tap sends: the first name the server gave for a typed whole name (D6). */
  label?: string;
  className?: string;
  armedClassName?: string;
}) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const { armed, setArmed, ref: button } = useTwoTap<HTMLButtonElement>();
  const [error, setError] = useState<string | null>(null);
  const tap = () => {
    if (!armed) {
      setError(null);
      setArmed(true);
      return;
    }
    setArmed(false);
    start(async () => {
      const r = await thatsMeAction(code, name);
      startTransition(() => {
        if (r.ok) return;
        setError(r.error === "too_many" ? t("errors.too_many") : t("identity.thatsMeNo"));
        if (r.error !== "too_many") requestBackIn();
      });
    });
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        data-testid="thats-me"
        data-armed={armed ? "true" : undefined}
        className={armed ? armedClassName : className}
        disabled={pending}
        onClick={tap}
        onBlur={() => setArmed(false)}
      >
        {pending ? t("common.working") : armed ? t("identity.thatsMeSure", { name: label }) : t("identity.thatsMeIn")}
      </button>
      {error && (
        <span role="status" className="block text-xs font-semibold text-danger">
          {error}
        </span>
      )}
    </>
  );
}

/** For a browser that already made its own record: the old record of the same name is in the crew, not on this roster. */
export function ThatsMeLine({ code, name }: { code: string; name: string }) {
  const t = useTranslations();
  return (
    <div data-testid="thats-me-line" className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3 text-sm text-muted">
      <span>{t("identity.thatsMeCrew", { name })}</span>
      <ThatsMeButton code={code} name={name} />
    </div>
  );
}
