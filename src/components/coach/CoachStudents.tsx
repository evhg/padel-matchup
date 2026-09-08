"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { addPackageAction, addStudentAction, extendPackageAction, setPackagePaidAction, setStudentStatusAction } from "@/actions/coach";
import { HowThisWorks } from "./HowThisWorks";
import { PromptPayQr } from "./PromptPayQr";

export type PackageDTO = { id: string; left: number; size: number; days: number | null; amount: number | null; currency: string; paid: boolean };
export type StudentDTO = { playerId: string; name: string; status: string; lessonsDone: number; thisMonth?: number; pkg: PackageDTO | null };

type Props = { coachName: string; students: StudentDTO[]; promptpayId: string | null; qrUrl: string | null; payLink: string | null; currency: string };

/** Students: requests to accept, packages to start, "paid" to note. One list, one action per row. */
export function CoachStudents({ coachName, students, promptpayId, qrUrl, payLink, currency }: Props) {
  const t = useTranslations("coach");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [packageFor, setPackageFor] = useState<string | null>(null);
  const [qrFor, setQrFor] = useState<PackageDTO | null>(null);

  const requests = students.filter((s) => s.status === "requested");
  const rest = students.filter((s) => s.status !== "requested");
  const act = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      router.refresh();
    });

  const pkgLine = (p: PackageDTO) => (p.days === null ? t("packageLineNoExpiry", { left: p.left, size: p.size }) : t("packageLine", { left: p.left, size: p.size, days: p.days }));
  const canShowQr = Boolean(promptpayId || qrUrl || payLink);

  return (
    <div className="flex flex-col gap-4">
      <section className="card">
        <h1 className="text-3xl font-extrabold tracking-tight">{t("students.title")}</h1>
        {requests.length > 0 && (
          <div className="mt-4">
            <div className="text-xs font-bold uppercase text-faint">{t("students.requests")}</div>
            <ul className="mt-1 flex flex-col gap-2">
              {requests.map((s) => (
                <li key={s.playerId} className="flex items-center justify-between gap-3 rounded-2xl border border-accent bg-accent-soft px-4 py-3">
                  <div className="font-bold">{s.name}</div>
                  <button type="button" className="btn-primary btn-sm" disabled={pending} onClick={() => act(() => setStudentStatusAction(s.playerId, "accepted"))}>
                    {t("students.accept")}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {rest.length === 0 && requests.length === 0 && <p className="mt-3 text-sm text-muted">{t("students.none")}</p>}
        <ul className="mt-3 flex flex-col gap-2">
          {rest.map((s) => (
            <li key={s.playerId} className={`rounded-2xl border border-line bg-white px-4 py-3 ${s.status === "paused" ? "opacity-60" : ""}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-bold">{s.name}</div>
                  <div className="text-xs text-muted">
                    {s.pkg ? pkgLine(s.pkg) : t("noPackage")}
                    {s.pkg ? ` · ${s.pkg.paid ? t("students.paid") : t("students.unpaid")}` : ""}
                    {s.lessonsDone > 0 ? ` · ${t("students.lessonsDone", { count: s.lessonsDone })}` : ""}
                  </div>
                </div>
                <button type="button" className="btn-ghost btn-xs shrink-0" disabled={pending} onClick={() => act(() => setStudentStatusAction(s.playerId, s.status === "paused" ? "accepted" : "paused"))}>
                  {s.status === "paused" ? t("students.resume") : t("students.pause")}
                </button>
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {s.pkg && !s.pkg.paid && (
                  <button type="button" className="btn-secondary btn-xs" disabled={pending} onClick={() => act(() => setPackagePaidAction(s.pkg!.id, true))}>
                    {t("students.markPaid")}
                  </button>
                )}
                {s.pkg && s.pkg.paid && (
                  <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => act(() => setPackagePaidAction(s.pkg!.id, false))}>
                    {t("students.markUnpaid")}
                  </button>
                )}
                {s.pkg && canShowQr && (
                  <button type="button" className="btn-ghost btn-xs" onClick={() => setQrFor(qrFor?.id === s.pkg!.id ? null : s.pkg)}>
                    {t("students.showQr")}
                  </button>
                )}
                {s.pkg && s.pkg.days !== null && (
                  <button type="button" className="btn-ghost btn-xs" disabled={pending} onClick={() => act(() => extendPackageAction(s.pkg!.id, 30))}>
                    {t("students.extend")}
                  </button>
                )}
                <button type="button" className="btn-ghost btn-xs" onClick={() => setPackageFor(packageFor === s.playerId ? null : s.playerId)}>
                  ＋ {t("students.addPackage")}
                </button>
              </div>
              {qrFor && s.pkg && qrFor.id === s.pkg.id && (
                <div className="mt-3 rounded-2xl border border-line bg-bg p-3 animate-pop">
                  <div className="text-sm font-bold">
                    {t("students.scanToPay", { name: coachName })}
                    {qrFor.amount ? ` · ${qrFor.amount} ${qrFor.currency}` : ""}
                  </div>
                  <div className="mt-2">
                    <PromptPayQr promptpayId={promptpayId} amount={qrFor.amount} imageUrl={qrUrl} />
                  </div>
                  {payLink && (
                    <a href={payLink} target="_blank" rel="noreferrer" className="btn-ghost btn-sm mt-2">
                      {t("students.payLink")} ↗
                    </a>
                  )}
                  <p className="mt-2 text-xs text-muted">{t("students.qrHelp")}</p>
                </div>
              )}
              {packageFor === s.playerId && (
                <PackageForm
                  currency={currency}
                  onDone={() => {
                    setPackageFor(null);
                    router.refresh();
                  }}
                  studentPlayerId={s.playerId}
                />
              )}
            </li>
          ))}
        </ul>
        {!adding ? (
          <button type="button" className="btn-ghost mt-4 w-full" onClick={() => setAdding(true)}>
            ＋ {t("students.add")}
          </button>
        ) : (
          <form
            className="mt-4 flex flex-col gap-2 animate-pop"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newName.trim()) return;
              act(async () => {
                await addStudentAction(newName, newEmail);
                setNewName("");
                setNewEmail("");
                setAdding(false);
              });
            }}
          >
            <div className="flex gap-2">
              <input className="input" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("book.newStudentName")} maxLength={40} autoFocus />
              <button type="submit" className="btn-primary" disabled={pending || !newName.trim()}>
                {t("students.add")}
              </button>
            </div>
            <input className="input" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} placeholder={t("students.emailOptional")} inputMode="email" autoComplete="off" maxLength={120} />
          </form>
        )}
        {adding && <p className="mt-1 text-xs text-faint">{t("students.addHelp")}</p>}
      </section>
      <HowThisWorks text={t("students.how")} />
    </div>
  );
}

function PackageForm({ studentPlayerId, currency, onDone }: { studentPlayerId: string; currency: string; onDone: () => void }) {
  const t = useTranslations("coach");
  const [pending, start] = useTransition();
  const [size, setSize] = useState(10);
  const [validDays, setValidDays] = useState(90);
  const [amount, setAmount] = useState("");
  const [paid, setPaid] = useState(false);
  return (
    <form
      className="mt-3 grid grid-cols-2 gap-3 rounded-2xl border border-line bg-bg p-3 animate-pop"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          await addPackageAction({ studentPlayerId, size, validDays: validDays || null, amount: amount ? Number(amount) : null, paid });
          onDone();
        });
      }}
    >
      <label className="text-xs font-bold text-muted">
        {t("students.size")}
        <input type="number" min={1} max={200} className="input mt-1" value={size} onChange={(e) => setSize(Number(e.target.value))} />
      </label>
      <label className="text-xs font-bold text-muted">
        {t("students.validDays")}
        <input type="number" min={0} max={730} className="input mt-1" value={validDays} onChange={(e) => setValidDays(Number(e.target.value))} />
      </label>
      <label className="text-xs font-bold text-muted">
        {t("students.amount")} ({currency})
        <input type="number" min={0} step={1} inputMode="numeric" className="input mt-1" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <label className="flex items-end gap-2 pb-2 text-sm font-bold">
        <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> {t("students.paidNow")}
      </label>
      <button type="submit" className="btn-primary col-span-2" disabled={pending || size < 1}>
        {pending ? "…" : t("students.create")}
      </button>
    </form>
  );
}
