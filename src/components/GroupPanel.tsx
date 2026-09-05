"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createGroupFromEventAction, joinGroupAction, leaveGroupAction, removeGroupMemberAction, updateGroupAction } from "@/actions/groups";
import { formatLevel } from "@/lib/domain/levels";

const errKey = (e: string) => (e === "name_required" || e === "no_identity" || e === "level_required" ? "generic" : e);

/** Match page: "Turn this crew into a group" (creator or any participant). */
export function CreateGroupButton({ code }: { code: string }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mt-5 border-t border-line pt-4">
      <button
        type="button"
        className="btn-secondary w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await createGroupFromEventAction(code);
            if (r.ok) router.push(`/g/${r.data.code}`);
            else setError(t(`errors.${errKey(r.error)}` as "errors.generic"));
          })
        }
      >
        {pending ? t("group.creating") : `👥 ${t("group.create")}`}
      </button>
      <p className="mt-1.5 text-xs text-faint">{t("group.createHelp")}</p>
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}

/** Join (with an inline name when there is no identity yet) or leave. */
export function GroupJoin({ code, member, hasIdentity, canLeave, name: groupName }: { code: string; member: boolean; hasIdentity: boolean; canLeave: boolean; name: string }) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const join = () =>
    start(async () => {
      setError(null);
      const r = await joinGroupAction(code, hasIdentity ? undefined : name);
      if (!r.ok) setError(r.error === "name_required" ? t("identity.nameRequired") : t(`errors.${errKey(r.error)}` as "errors.generic"));
    });
  if (member) {
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="font-extrabold text-ok">✓ {t("group.joined")}</div>
        {canLeave && (
          <button
            type="button"
            className="btn-ghost btn-sm"
            disabled={pending}
            onClick={() => {
              if (!confirm(t("group.leaveConfirm", { name: groupName }))) return;
              start(async () => {
                const r = await leaveGroupAction(code);
                if (!r.ok) setError(t(`errors.${errKey(r.error)}` as "errors.generic"));
              });
            }}
          >
            {t("group.leave")}
          </button>
        )}
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    );
  }
  if (hasIdentity || !open) {
    return (
      <div>
        <button type="button" className="btn-primary w-full" disabled={pending} onClick={() => (hasIdentity ? join() : setOpen(true))}>
          {pending ? t("common.working") : t("group.join")}
        </button>
        {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 animate-pop"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim()) return setError(t("identity.nameRequired"));
        join();
      }}
    >
      <div className="text-sm font-bold text-court">{t("identity.whatsYourName")}</div>
      <div className="flex gap-2">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("identity.namePlaceholder")} autoComplete="given-name" maxLength={40} enterKeyHint="go" />
        <button type="submit" className="btn-primary shrink-0" disabled={pending}>
          {pending ? t("common.working") : t("group.join")}
        </button>
      </div>
      {error ? <p className="text-sm font-semibold text-danger">{error}</p> : <p className="text-xs text-faint">{t("identity.nameHelp")}</p>}
    </form>
  );
}

export type MemberRow = { playerId: string; name: string; level: number | null; role: "admin" | "member"; isMe: boolean; removable: boolean };

export function GroupMembers({ code, members }: { code: string; members: MemberRow[] }) {
  const t = useTranslations();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <ul className="mt-3 flex flex-col gap-2">
      {members.map((m) => (
        <li key={m.playerId} className="flex items-center gap-3 rounded-2xl border border-line bg-white px-4 py-3">
          <span className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-sm font-extrabold text-white">{m.name.slice(0, 1).toUpperCase()}</span>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-bold">{m.name}</span>
            {m.level != null && <span className="chip-muted tabular-nums">{formatLevel(m.level)}</span>}
            {m.isMe && <span className="chip-open">{t("common.you")}</span>}
            {m.role === "admin" && <span className="chip-muted">{t("group.admin")}</span>}
          </div>
          {m.removable && (
            <button
              type="button"
              className="btn-ghost btn-xs"
              disabled={pending && busy === m.playerId}
              onClick={() => {
                setBusy(m.playerId);
                start(async () => {
                  await removeGroupMemberAction(code, m.playerId);
                  setBusy(null);
                });
              }}
            >
              {t("group.remove")}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Admin: name and the weekly slot that creates matches automatically. */
export function GroupSettings({ code, name, recurDow, recurTime, recurLeadDays, weekdays }: { code: string; name: string; recurDow: number | null; recurTime: string | null; recurLeadDays: number; weekdays: string[] }) {
  const t = useTranslations();
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(name);
  const [dow, setDow] = useState<number | null>(recurDow);
  const [time, setTime] = useState(recurTime ?? "19:00");
  const [lead, setLead] = useState(recurLeadDays);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (!open) {
    return (
      <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(true)}>
        ✎ {t("group.settings")}
      </button>
    );
  }
  return (
    <form
      className="flex flex-col gap-3 animate-pop"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          setError(null);
          const r = await updateGroupAction(code, { name: n, recurDow: dow, recurTime: dow == null ? null : time, recurLeadDays: lead });
          if (!r.ok) setError(t(`errors.${errKey(r.error)}` as "errors.generic"));
          else setOpen(false);
        });
      }}
    >
      <label className="block">
        <span className="label">{t("group.name")}</span>
        <input className="input" value={n} maxLength={60} onChange={(e) => setN(e.target.value)} placeholder={t("group.namePlaceholder")} />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="block">
          <span className="label">{t("group.repeats")}</span>
          <select className="input px-3" value={dow == null ? "" : String(dow)} onChange={(e) => setDow(e.target.value === "" ? null : Number(e.target.value))}>
            <option value="">{t("group.none")}</option>
            {weekdays.map((w, i) => (
              <option key={i} value={i}>
                {w}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">{t("create.time")}</span>
          <input className="input" type="time" step={300} value={time} disabled={dow == null} onChange={(e) => setTime(e.target.value)} />
        </label>
      </div>
      {dow != null && (
        <label className="block">
          <span className="label">{t("group.leadDays", { n: lead })}</span>
          <input type="range" min={1} max={14} value={lead} onChange={(e) => setLead(Number(e.target.value))} className="w-full" aria-label={t("group.leadDays", { n: lead })} />
          <p className="mt-1 text-xs text-faint">{t("group.autoHelp", { n: lead })}</p>
        </label>
      )}
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-secondary btn-sm" disabled={pending}>
          {pending ? t("common.saving") : t("group.save")}
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}
