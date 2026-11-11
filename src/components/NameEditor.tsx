"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { updateMyName } from "@/actions/identity";

export function NameEditor({ name }: { name: string }) {
  const t = useTranslations();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [pending, start] = useTransition();
  const [error, setError] = useState(false);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setError(false);
    start(async () => {
      const r = await updateMyName(value);
      // A refused save keeps the field open with the words typed, and says so.
      if (r.ok) setEditing(false);
      else setError(true);
    });
  };
  const cancel = () => {
    setValue(name);
    setError(false);
    setEditing(false);
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
    <form onSubmit={save} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input className="input" value={value} onChange={(e) => setValue(e.target.value)} maxLength={40} autoFocus />
        <button type="submit" className="btn-secondary" disabled={pending}>
          {t("common.save")}
        </button>
      </div>
      {error && <p className="text-sm font-semibold text-danger">{t("errors.generic")}</p>}
      <button type="button" className="self-start text-sm link" onClick={cancel} disabled={pending}>
        {t("common.cancel")}
      </button>
    </form>
  );
}
