"use client";

import { useTranslations } from "next-intl";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { joinAction, reserveAction } from "@/actions/slots";
import { registerJoinHandler } from "./joinBus";

export type RolodexItem = { name: string; email: string | null; phone: string | null };
type Mode = "reserve" | "join" | "none";

/**
 * An empty roster row that expands in place — never a popup.
 *  - Organizer: name (+ optional phone/email) and Done → spot reserved; with an
 *    email the invite goes out automatically.
 *  - Anyone not in yet: joins on tap, or expands into a name field first.
 */
export function OpenSpot({
  code,
  slotId,
  mode,
  label,
  hasIdentity,
  rolodex,
  emailEnabled,
}: {
  code: string;
  slotId: string;
  mode: Mode;
  label: string;
  hasIdentity: boolean;
  rolodex: RolodexItem[];
  emailEnabled: boolean;
}) {
  const t = useTranslations();
  const errText = (error: string) =>
    error === "name_required" ? t("identity.nameRequired") : error === "invalid" ? t("errors.slot_taken") : error === "full" ? t("creator.noSpots") : t(`errors.${error === "no_identity" ? "generic" : error}` as "errors.generic");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const expand = useCallback(() => {
    setOpen(true);
    requestAnimationFrame(() => {
      box.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      input.current?.focus({ preventScroll: true });
    });
  }, []);

  // The fixed Join button hands its no-identity case to the first open row.
  useEffect(() => {
    if (mode !== "join" || hasIdentity) return;
    return registerJoinHandler(expand);
  }, [mode, hasIdentity, expand]);

  const join = (withName?: string) =>
    start(async () => {
      setError(null);
      const r = await joinAction(code, withName);
      startTransition(() => {
        if (!r.ok) setError(errText(r.error));
      });
    });

  const reserve = () => {
    if (!name.trim()) return setError(t("identity.nameRequired"));
    start(async () => {
      setError(null);
      const r = await reserveAction(code, { name, phone: phone || undefined, email: email || undefined, slotId });
      startTransition(() => {
        if (!r.ok) setError(errText(r.error));
      });
    });
  };

  const suggestions = useMemo(() => {
    if (mode !== "reserve") return [];
    const q = name.trim().toLowerCase();
    return (q ? rolodex.filter((r) => r.name.toLowerCase().includes(q) && r.name.toLowerCase() !== q) : rolodex).slice(0, 5);
  }, [rolodex, name, mode]);

  const tap = () => {
    if (mode === "reserve") expand();
    else if (mode === "join" && hasIdentity) join();
    else if (mode === "join") expand();
  };

  const avatar = <span className={`inline-grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-extrabold ${mode === "none" ? "bg-line text-muted" : "bg-court-soft text-court"}`}>{mode === "none" ? "·" : "+"}</span>;

  if (mode === "none") {
    return (
      <div className="flex items-center gap-3">
        {avatar}
        <span className="font-semibold text-muted">{label}</span>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" className="flex w-full items-center gap-3 rounded-xl text-left" disabled={pending} onClick={tap}>
        {avatar}
        <span className="min-w-0 flex-1">
          <span className="block font-semibold text-muted">{label}</span>
          <span className="block text-xs font-semibold text-court">{pending ? t("common.working") : mode === "reserve" ? t("event.tapToReserve") : t("event.tapToJoin")}</span>
        </span>
        <span className="text-faint">›</span>
      </button>
    );
  }

  const hasNames = name.trim().length > 0;
  return (
    <div ref={box} className="animate-pop">
      <div className="mb-2 flex items-center gap-3">
        {avatar}
        <span className="text-sm font-bold text-court">{mode === "reserve" ? t("creator.reserveInline") : t("identity.whatsYourName")}</span>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === "reserve") reserve();
          else if (!hasNames) setError(t("identity.nameRequired"));
          else join(name);
        }}
      >
        <div className="flex gap-2">
          <input
            ref={input}
            className="input"
            placeholder={mode === "reserve" ? t("creator.name") : t("identity.namePlaceholder")}
            value={name}
            autoComplete={mode === "reserve" ? "off" : "given-name"}
            maxLength={40}
            enterKeyHint={mode === "reserve" ? "done" : "go"}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn-primary shrink-0" disabled={pending}>
            {pending ? t("common.working") : mode === "reserve" ? t("creator.reserveDone") : t("event.joinShort")}
          </button>
        </div>
        {mode === "reserve" && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((r) => (
              <button
                key={r.name}
                type="button"
                className="chip-muted min-h-9 px-3 text-sm"
                onClick={() => {
                  setName(r.name);
                  setPhone(r.phone ?? "");
                  setEmail(r.email ?? "");
                  input.current?.focus({ preventScroll: true });
                }}
              >
                {r.name}
                {r.email || r.phone ? " ·" : ""} {r.phone ? "📱" : ""}
                {r.email ? "✉️" : ""}
              </button>
            ))}
          </div>
        )}
        {mode === "reserve" && (
          <div className="grid grid-cols-2 gap-2">
            <input className="input min-h-11 text-sm" type="tel" inputMode="tel" autoComplete="off" placeholder={`${t("creator.phone")} (${t("common.optional")})`} value={phone} onChange={(e) => setPhone(e.target.value)} />
            {emailEnabled && <input className="input min-h-11 text-sm" type="email" inputMode="email" autoComplete="off" placeholder={`${t("creator.email")} (${t("common.optional")})`} value={email} onChange={(e) => setEmail(e.target.value)} />}
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          {error ? <span className="text-sm font-semibold text-danger">{error}</span> : <span className="text-xs text-faint">{mode === "reserve" ? t("creator.reserveSheetHelp") : t("identity.nameHelp")}</span>}
          <button type="button" className="shrink-0 text-sm link" onClick={() => setOpen(false)}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </div>
  );
}
