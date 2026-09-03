"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState, useTransition } from "react";
import { reserveAction } from "@/actions/slots";
import { ShareButtons } from "./ShareSheet";

export type RolodexItem = { name: string; email: string | null; phone: string | null };

const RESERVE_EVENT = "km-reserve";
export const JOIN_EVENT = "km-join";
type ReserveDetail = { slotId: string; position: number };

/**
 * An empty roster row. Organizer: tap → reserve this exact spot for someone.
 * Everyone else (not yet in): tap → same as the Join button.
 */
export function OpenSpot({ mode, label, slotId, position }: { mode: "reserve" | "join" | "none"; label: string; slotId: string; position: number }) {
  const t = useTranslations();
  const inner = (
    <>
      <span className={`inline-grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-extrabold ${mode === "none" ? "bg-line text-muted" : "bg-court-soft text-court"}`}>{mode === "none" ? "·" : "+"}</span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold text-muted">{label}</span>
        {mode !== "none" && <span className="block text-xs font-semibold text-court">{mode === "reserve" ? t("event.tapToReserve") : t("event.tapToJoin")}</span>}
      </span>
      {mode !== "none" && <span className="text-faint">›</span>}
    </>
  );
  if (mode === "none") return <div className="flex items-center gap-3">{inner}</div>;
  return (
    <button
      type="button"
      className="flex w-full items-center gap-3 rounded-xl text-left"
      onClick={() => window.dispatchEvent(mode === "reserve" ? new CustomEvent<ReserveDetail>(RESERVE_EVENT, { detail: { slotId, position } }) : new CustomEvent(JOIN_EVENT))}
    >
      {inner}
    </button>
  );
}

/**
 * Mounted once per page (organizer only). Stays mounted across the
 * revalidation that turns the tapped row into "Reserved for …", so the
 * forward-the-invite step survives.
 */
export function ReserveHost({ code, rolodex, inviteTextTemplate, emailEnabled }: { code: string; rolodex: RolodexItem[]; inviteTextTemplate: string; emailEnabled: boolean }) {
  const [target, setTarget] = useState<ReserveDetail | null>(null);
  useEffect(() => {
    const onReserve = (e: Event) => setTarget((e as CustomEvent<ReserveDetail>).detail);
    window.addEventListener(RESERVE_EVENT, onReserve);
    return () => window.removeEventListener(RESERVE_EVENT, onReserve);
  }, []);
  if (!target) return null;
  return <ReserveSheet key={target.slotId} code={code} slotId={target.slotId} position={target.position} rolodex={rolodex} inviteTextTemplate={inviteTextTemplate} emailEnabled={emailEnabled} onClose={() => setTarget(null)} />;
}

function ReserveSheet({
  code,
  slotId,
  position,
  rolodex,
  inviteTextTemplate,
  emailEnabled,
  onClose,
}: {
  code: string;
  slotId: string;
  position: number;
  rolodex: RolodexItem[];
  /** Localized text with __NAME__ and __URL__ placeholders. */
  inviteTextTemplate: string;
  emailEnabled: boolean;
  onClose: () => void;
}) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ name: string; url: string; phone: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const matches = useMemo(() => {
    const q = name.trim().toLowerCase();
    if (!q) return rolodex.slice(0, 5);
    return rolodex.filter((r) => r.name.toLowerCase().includes(q)).slice(0, 5);
  }, [rolodex, name]);

  const pick = (r: RolodexItem) => {
    setName(r.name);
    setPhone(r.phone ?? "");
    setEmail(r.email ?? "");
    if (r.phone || r.email) setMore(true);
    setOpen(false);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError(t("identity.nameRequired"));
    setError(null);
    start(async () => {
      const r = await reserveAction(code, { name, phone: phone || undefined, email: email || undefined, slotId });
      if (!r.ok) {
        setError(r.error === "full" ? t("creator.noSpots") : r.error === "invalid" ? t("errors.slot_taken") : t("common.somethingWrong"));
        return;
      }
      setCreated({ name: r.data.name, url: r.data.inviteUrl, phone });
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-ink/40 p-3 sm:items-center" onClick={onClose}>
      <div className="card w-full max-w-md animate-pop" onClick={(e) => e.stopPropagation()}>
        {created ? (
          <>
            <h2 className="text-xl font-extrabold tracking-tight">{t("event.reservedFor", { name: created.name })}</h2>
            <p className="mt-1 mb-3 text-sm text-muted">{t("creator.reserveHelp")}</p>
            <ShareButtons url={created.url} text={inviteTextTemplate.replace("__NAME__", created.name).replace("__URL__", created.url)} phone={created.phone} />
            <button type="button" className="btn-ghost mt-3 w-full" onClick={onClose}>
              {t("common.done")}
            </button>
          </>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-2">
            <h2 className="text-xl font-extrabold tracking-tight">{t("creator.reserveSpot", { n: position })}</h2>
            <p className="mb-1 text-sm text-muted">{t("creator.reserveSheetHelp")}</p>
            <div className="relative">
              <input
                className="input"
                placeholder={t("creator.name")}
                value={name}
                autoFocus
                autoComplete="off"
                maxLength={40}
                onChange={(e) => {
                  setName(e.target.value);
                  setOpen(true);
                }}
                onFocus={() => setOpen(true)}
                onBlur={() => setTimeout(() => setOpen(false), 120)}
              />
              {open && matches.length > 0 && (
                <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-2xl border border-line bg-white shadow-card">
                  {matches.map((r) => (
                    <li key={r.name}>
                      <button type="button" className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-bg" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(r)}>
                        <span className="font-semibold">{r.name}</span>
                        <span className="text-xs text-muted">{[r.phone && "📱", r.email && "✉️"].filter(Boolean).join(" ")}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {rolodex.length > 0 && !open && !name && <p className="text-xs text-faint">{t("creator.rolodexHint")}</p>}
            {more ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <input className="input" type="tel" inputMode="tel" placeholder={`${t("creator.phone")} (${t("common.optional")})`} value={phone} onChange={(e) => setPhone(e.target.value)} />
                {emailEnabled && <input className="input" type="email" inputMode="email" placeholder={`${t("creator.email")} (${t("common.optional")})`} value={email} onChange={(e) => setEmail(e.target.value)} />}
              </div>
            ) : (
              <button type="button" className="self-start text-sm link" onClick={() => setMore(true)}>
                + {t("creator.phone")}
                {emailEnabled ? ` / ${t("creator.email")}` : ""}
              </button>
            )}
            {error && <p className="text-sm font-semibold text-danger">{error}</p>}
            <button type="submit" className="btn-primary mt-1 w-full text-lg" disabled={pending}>
              {pending ? t("common.working") : t("creator.reserveSubmit")}
            </button>
            <button type="button" className="btn-ghost w-full" onClick={onClose}>
              {t("common.cancel")}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
