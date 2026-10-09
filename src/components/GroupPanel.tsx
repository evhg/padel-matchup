"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createGroupFromEventAction, decideGroupRequestAction, deleteGroupAction, handOverGroupAction, joinGroupAction, leaveGroupAction, removeGroupMemberAction, updateGroupAction, withdrawGroupRequestAction } from "@/actions/groups";
import { ASK_NOTE_MAX } from "@/lib/domain/groupAccess";
import { formatLevel } from "@/lib/domain/levels";

const errKey = (e: string) => (e === "name_required" || e === "no_identity" || e === "level_required" ? "generic" : e);

/** Match page: "Turn this crew into a group" (creator or any participant). The name is seen, and can be changed, before the group exists. */
export function CreateGroupButton({ code, suggestions }: { code: string; suggestions: string[] }) {
  const t = useTranslations();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [roll, setRoll] = useState(0);
  const [name, setName] = useState(suggestions[0] ?? "");
  const rollDice = () => {
    const next = (roll + 1) % Math.max(1, suggestions.length);
    setRoll(next);
    setName(suggestions[next] ?? "");
  };
  const [error, setError] = useState<string | null>(null);
  const create = () =>
    start(async () => {
      setError(null);
      const r = await createGroupFromEventAction(code, name.trim() || undefined);
      if (r.ok) router.push(`/g/${r.data.code}`);
      else setError(t(`errors.${errKey(r.error)}` as "errors.generic"));
    });
  if (!open) {
    return (
      <div className="mt-5 border-t border-line pt-4">
        <button type="button" className="btn-secondary w-full" onClick={() => setOpen(true)}>
          {`👥 ${t("group.create")}`}
        </button>
        <p className="mt-1.5 text-xs text-faint">{t("group.createHelp")}</p>
      </div>
    );
  }
  return (
    <form
      className="mt-5 flex flex-col gap-2 border-t border-line pt-4 animate-pop"
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <label className="text-sm font-bold" htmlFor="group-name">
        {t("group.name")}
      </label>
      <div className="flex gap-2">
        <input id="group-name" className="input" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder={t("group.namePlaceholder")} enterKeyHint="go" />
        {suggestions.length > 1 && (
          <button type="button" className="btn-ghost shrink-0" onClick={rollDice} aria-label={t("group.anotherName")} title={t("group.anotherName")}>
            🎲
          </button>
        )}
      </div>
      <p className="text-xs text-faint">{t("group.nameHelp")}</p>
      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? t("group.creating") : `👥 ${t("group.createNow")}`}
      </button>
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </form>
  );
}

/** The viewer's own ask, as the page found it: waiting, or declined with the day they may ask again. */
export type MyAsk = { status: "pending" } | { status: "declined"; againOn: string } | null;

/**
 * Join (with an inline name when there is no identity yet) or leave. A group that asks to join gets
 * `GroupAsk` instead of the one-tap button, and the leave confirmation says that coming back is an ask.
 */
export function GroupJoin({ code, member, hasIdentity, canLeave, name: groupName, askToJoin = false, ask = null }: { code: string; member: boolean; hasIdentity: boolean; canLeave: boolean; name: string; askToJoin?: boolean; ask?: MyAsk }) {
  if (askToJoin && !member) return <GroupAsk code={code} hasIdentity={hasIdentity} ask={ask} />;
  return <GroupJoinOpen code={code} member={member} hasIdentity={hasIdentity} canLeave={canLeave} name={groupName} askToJoin={askToJoin} />;
}

function GroupJoinOpen({ code, member, hasIdentity, canLeave, name: groupName, askToJoin }: { code: string; member: boolean; hasIdentity: boolean; canLeave: boolean; name: string; askToJoin: boolean }) {
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
              if (!confirm(t(askToJoin ? "group.leaveConfirmAsk" : "group.leaveConfirm", { name: groupName }))) return;
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

/**
 * "Ask to join" (decision E): the person asks with an optional note, then sees "Asked" and can take it
 * back; a declined ask says kindly when they may ask again. What the page renders after each tap is
 * the server's, so the state survives a reload and never races a message held in the browser.
 */
function GroupAsk({ code, hasIdentity, ask }: { code: string; hasIdentity: boolean; ask: MyAsk }) {
  const t = useTranslations();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (ask?.status === "pending") {
    return (
      <div className="flex items-center justify-between gap-3" data-testid="group-asked">
        <div className="min-w-0">
          <div className="font-extrabold">✋ {t("group.asked")}</div>
          <div className="text-xs text-muted">{t("group.askedHelp")}</div>
        </div>
        <button
          type="button"
          className="btn-ghost btn-sm shrink-0"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const r = await withdrawGroupRequestAction(code);
              if (!r.ok) setError(t("errors.generic"));
            })
          }
        >
          {pending ? t("common.working") : t("level.withdraw")}
        </button>
        {error && <span className="text-sm text-danger">{error}</span>}
      </div>
    );
  }
  if (ask?.status === "declined") {
    return (
      <div data-testid="group-ask-declined">
        <div className="font-extrabold">{t("group.declinedTitle")}</div>
        <p className="text-xs text-muted">{t("group.declinedHelp", { date: ask.againOn })}</p>
      </div>
    );
  }
  const send = () =>
    start(async () => {
      setError(null);
      const r = await joinGroupAction(code, hasIdentity ? undefined : name, note);
      if (!r.ok) setError(r.error === "name_required" ? t("identity.nameRequired") : t(`errors.${errKey(r.error)}` as "errors.generic"));
    });
  if (!open) {
    return (
      <div>
        <button type="button" className="btn-primary w-full" onClick={() => setOpen(true)}>
          {t("group.askToJoin")}
        </button>
        <p className="mt-1.5 text-xs text-faint">{t("group.askHelp")}</p>
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 animate-pop"
      onSubmit={(e) => {
        e.preventDefault();
        if (!hasIdentity && !name.trim()) return setError(t("identity.nameRequired"));
        send();
      }}
    >
      {!hasIdentity && (
        <>
          <div className="text-sm font-bold text-court">{t("identity.whatsYourName")}</div>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder={t("identity.namePlaceholder")} autoComplete="given-name" maxLength={40} />
        </>
      )}
      <label className="label" htmlFor="group-ask-note">
        {t("group.askNote")}
      </label>
      <textarea id="group-ask-note" className="input min-h-20 py-2" value={note} maxLength={ASK_NOTE_MAX} onChange={(e) => setNote(e.target.value)} placeholder={t("group.askNotePlaceholder")} />
      <button type="submit" className="btn-primary w-full" disabled={pending}>
        {pending ? t("common.working") : t("group.askToJoin")}
      </button>
      {error ? <p className="text-sm font-semibold text-danger">{error}</p> : <p className="text-xs text-faint">{t("group.askHelp")}</p>}
    </form>
  );
}

export type GroupAskItem = { id: string; name: string; level: number | null; note: string | null; ago: string };

/** Admin only: the pending asks, with the asker's level and note, and Approve or Decline on each. */
export function GroupRequests({ code, items }: { code: string; items: GroupAskItem[] }) {
  const t = useTranslations();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (items.length === 0) return null;
  const decide = (id: string, approve: boolean) => {
    setBusy(id);
    start(async () => {
      setError(null);
      const r = await decideGroupRequestAction(code, id, approve);
      if (!r.ok) setError(t(`errors.${errKey(r.error)}` as "errors.generic"));
      setBusy(null);
    });
  };
  return (
    <div className="mt-4 rounded-2xl border border-warn/40 bg-warn-soft/40 p-3" data-testid="group-asks">
      <div className="font-extrabold">{t("group.asksTitle")}</div>
      <p className="text-xs text-muted">{t("group.asksHelp")}</p>
      <ul className="mt-2 flex flex-col gap-3">
        {items.map((r) => (
          <li key={r.id} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-bold">{r.name}</span>
              {r.level != null && <span className="chip-muted tabular-nums">{formatLevel(r.level)}</span>}
              <span className="text-xs text-faint">{t("level.asked", { ago: r.ago })}</span>
            </div>
            {r.note && <p className="text-sm text-muted break-words">💬 {r.note}</p>}
            <div className="flex gap-1.5">
              <button type="button" className="btn-secondary btn-sm" disabled={pending && busy === r.id} onClick={() => decide(r.id, true)}>
                {t("level.approve")}
              </button>
              <button type="button" className="btn-ghost btn-sm" disabled={pending && busy === r.id} onClick={() => decide(r.id, false)}>
                {t("level.decline")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-sm font-semibold text-danger">{error}</p>}
    </div>
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
        <li key={m.playerId} className="flex items-center gap-3 rounded-2xl border border-line bg-card px-4 py-3">
          <span className="inline-grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ink text-sm font-extrabold text-on-ink">{m.name.slice(0, 1).toUpperCase()}</span>
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

/** Admin: name, the weekly slot that creates matches automatically, whether new people ask to join, and under them the group handed to another member. */
export function GroupSettings({ code, name, recurDow, recurTime, recurLeadDays, weekdays, others, askToJoin = false }: { code: string; name: string; recurDow: number | null; recurTime: string | null; recurLeadDays: number; weekdays: string[]; others: { playerId: string; name: string }[]; askToJoin?: boolean }) {
  const t = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(name);
  const [ask, setAsk] = useState(askToJoin);
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
          const r = await updateGroupAction(code, { name: n, recurDow: dow, recurTime: dow == null ? null : time, recurLeadDays: lead, askToJoin: ask });
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
      <div>
        <label className="flex items-center gap-3 text-sm font-semibold">
          <input type="checkbox" className="h-4 w-4 accent-ink" checked={ask} onChange={(e) => setAsk(e.target.checked)} />
          {t("group.askToJoin")}
        </label>
        <p className="mt-1 text-xs text-faint">{t("group.askToJoinHelp")}</p>
      </div>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn-secondary btn-sm" disabled={pending}>
          {pending ? t("common.saving") : t("group.save")}
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="btn-ghost btn-sm ml-auto text-danger"
          disabled={pending}
          onClick={() => {
            if (!confirm(t("group.deleteConfirm", { name }))) return;
            start(async () => {
              const r = await deleteGroupAction(code);
              if (r.ok) router.push("/me");
              else setError(t(`errors.${errKey(r.error)}` as "errors.generic"));
            });
          }}
        >
          {t("group.delete")}
        </button>
      </div>
      {others.length > 0 && <HandOver code={code} name={name} others={others} />}
    </form>
  );
}

/** Inside the settings: the admin picks a current member and hands the group over. They stay a member. */
function HandOver({ code, name, others }: { code: string; name: string; others: { playerId: string; name: string }[] }) {
  const t = useTranslations();
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const pick = others.find((o) => o.playerId === to);
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <label className="block">
        <span className="label">{t("group.handOverTo")}</span>
        <select className="input px-3" value={to} onChange={(e) => setTo(e.target.value)}>
          <option value="">{t("group.handOverPick")}</option>
          {others.map((o) => (
            <option key={o.playerId} value={o.playerId}>
              {o.name}
            </option>
          ))}
        </select>
      </label>
      <p className="text-xs text-faint">{t("group.handOverHelp")}</p>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
      <button
        type="button"
        className="btn-ghost btn-sm self-start"
        disabled={pending || !pick}
        onClick={() => {
          if (!pick || !confirm(t("group.handOverConfirm", { name, member: pick.name }))) return;
          start(async () => {
            setError(null);
            const r = await handOverGroupAction(code, pick.playerId);
            if (!r.ok) setError(r.error === "not_member" ? t("group.handOverGone") : t(`errors.${errKey(r.error)}` as "errors.generic"));
          });
        }}
      >
        {pending ? t("common.working") : t("group.handOver")}
      </button>
    </div>
  );
}
