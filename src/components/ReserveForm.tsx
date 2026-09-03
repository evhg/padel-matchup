"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { reserveAction } from "@/actions/slots";
import { ShareButtons } from "./ShareSheet";

export type RolodexItem = { name: string; email: string | null; phone: string | null };

export function ReserveForm({
  code,
  rolodex,
  canReserve,
  inviteTextTemplate,
  emailEnabled,
}: {
  code: string;
  rolodex: RolodexItem[];
  canReserve: boolean;
  /** Localized text with __NAME__ and __URL__ placeholders. */
  inviteTextTemplate: string;
  emailEnabled: boolean;
}) {
  const t = useTranslations();
  const router = useRouter();
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
      const r = await reserveAction(code, { name, phone: phone || undefined, email: email || undefined });
      if (!r.ok) {
        setError(r.error === "full" ? t("creator.noSpots") : t("common.somethingWrong"));
        return;
      }
      setCreated({ name: r.data.name, url: r.data.inviteUrl, phone });
      setName("");
      setPhone("");
      setEmail("");
      setMore(false);
      router.refresh();
    });
  };

  return (
    <div>
      <h3 className="font-extrabold">{t("creator.reserve")}</h3>
      <p className="mt-0.5 text-sm text-muted">{t("creator.reserveHelp")}</p>

      {created && (
        <div className="mt-3 rounded-2xl border border-accent bg-accent-soft p-3 animate-pop">
          <div className="mb-2 text-sm font-bold">{t("event.reservedFor", { name: created.name })}</div>
          <ShareButtons url={created.url} text={inviteTextTemplate.replace("__NAME__", created.name).replace("__URL__", created.url)} phone={created.phone} size="sm" />
          <button type="button" className="mt-2 text-sm link" onClick={() => setCreated(null)}>
            {t("common.done")}
          </button>
        </div>
      )}

      {canReserve ? (
        <form onSubmit={submit} className="mt-3 flex flex-col gap-2">
          <div className="relative">
            <input
              className="input"
              placeholder={t("creator.name")}
              value={name}
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
          <button type="submit" className="btn-secondary" disabled={pending}>
            {pending ? t("common.working") : t("creator.reserveSubmit")}
          </button>
        </form>
      ) : (
        <p className="mt-3 text-sm font-semibold text-warn">{t("creator.noSpots")}</p>
      )}
    </div>
  );
}
