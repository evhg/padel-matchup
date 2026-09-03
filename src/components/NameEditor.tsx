"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { updateMyName } from "@/actions/identity";

export function NameEditor({ name }: { name: string }) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, start] = useTransition();
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    start(async () => {
      await updateMyName(value);
      setEditing(false);
    });
  };
  if (!editing) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-faint">{t("me.you")}</div>
          <div className="text-xl font-extrabold">{name}</div>
        </div>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(true)}>
          {t("identity.editName")}
        </button>
      </div>
    );
  }
  return (
    <form onSubmit={save} className="flex gap-2">
      <input className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={40} autoFocus />
      <button type="submit" className="btn-secondary" disabled={pending}>
        {t("common.save")}
      </button>
    </form>
  );
}
