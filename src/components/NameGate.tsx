"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { ensureIdentity } from "@/actions/identity";

export function NameGate({ title, onDone, cta }: { title?: string; onDone?: (name: string) => void; cta?: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError(t("identity.nameRequired"));
      return;
    }
    start(async () => {
      const r = await ensureIdentity(name);
      if (!r.ok) {
        setError(t("common.somethingWrong"));
        return;
      }
      onDone?.(r.data.name);
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="card animate-pop">
      <h2 className="text-xl font-extrabold tracking-tight">{title ?? t("identity.whatsYourName")}</h2>
      <p className="mt-1 text-sm text-muted">{t("identity.nameHelp")}</p>
      <input
        className="input mt-4"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("identity.namePlaceholder")}
        autoComplete="given-name"
        autoFocus
        maxLength={40}
        enterKeyHint="done"
      />
      {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
      <button type="submit" className="btn-primary mt-3 w-full" disabled={pending}>
        {pending ? t("common.working") : (cta ?? t("identity.continue"))}
      </button>
    </form>
  );
}
