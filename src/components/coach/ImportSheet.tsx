"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { confirmImportAction, previewImportAction, type ImportPreview } from "@/actions/coach";
import type { ImportRow } from "@/lib/coach/import";

/**
 * The coach's existing sheet, in three taps: paste (or a Google Sheet link), look, confirm.
 * The preview is the safety: nothing is written until the coach has seen every row.
 */
export function ImportSheet() {
  const t = useTranslations("coach.import");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; newStudents: number; matched: number } | null>(null);

  const readIt = () => {
    setError(null);
    setDone(null);
    start(async () => {
      const r = await previewImportAction(text);
      if (!r.ok) {
        setError(r.error === "invalid" ? t(r.detail === "not_shared" ? "notShared" : r.detail === "link" ? "badLink" : r.detail === "unreachable" ? "unreachable" : "nothing") : t("nothing"));
        return;
      }
      if (r.data.rows.length === 0) {
        setError(t("nothing"));
        return;
      }
      setPreview(r.data);
    });
  };

  const confirm = () => {
    if (!preview) return;
    setError(null);
    start(async () => {
      const r = await confirmImportAction(preview.rows);
      if (!r.ok) {
        setError(t("nothing"));
        return;
      }
      setDone(r.data);
      setPreview(null);
      setText("");
      router.refresh();
    });
  };

  const drop = (i: number) => setPreview((p) => (p ? { ...p, rows: p.rows.filter((_, j) => j !== i) } : p));

  if (!open) {
    return (
      <section className="card flex flex-col gap-2" data-testid="import-sheet">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight">{t("title")}</h2>
            <p className="text-xs text-muted">{t("lead")}</p>
          </div>
          <button type="button" className="btn-ghost shrink-0" onClick={() => setOpen(true)}>
            {t("open")}
          </button>
        </div>
        {done && <p className="text-sm font-semibold text-ok">✓ {t("done", { created: done.created, students: done.newStudents, matched: done.matched })}</p>}
      </section>
    );
  }

  return (
    <section className="card flex flex-col gap-3" data-testid="import-sheet">
      <div>
        <h2 className="text-lg font-extrabold tracking-tight">{t("title")}</h2>
        <p className="text-xs text-muted">{t("lead")}</p>
      </div>
      {!preview && (
        <>
          <textarea className="input min-h-32 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("placeholder")} spellCheck={false} data-testid="import-text" />
          <p className="text-xs text-faint">{t("linkHelp")}</p>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1" disabled={pending || !text.trim()} onClick={readIt}>
              {pending ? "…" : t("read")}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>
              {t("close")}
            </button>
          </div>
        </>
      )}
      {preview && (
        <>
          <p className="text-sm text-muted">{t("previewLead", { n: preview.rows.length, skipped: preview.skipped })}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="import-preview">
              <thead className="text-xs uppercase tracking-wide text-faint">
                <tr>
                  <th className="py-1 pr-2">{t("colName")}</th>
                  <th className="py-1 pr-2">{t("colPackage")}</th>
                  <th className="py-1 pr-2">{t("colExpires")}</th>
                  <th className="py-1 pr-2">{t("colPaid")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r: ImportRow, i) => (
                  <tr key={`${r.name}-${i}`} className="border-t border-line">
                    <td className="py-1 pr-2 font-semibold">
                      {r.name}
                      {preview.known.includes(r.name) && <span className="ml-1 text-xs font-normal text-faint">{t("known")}</span>}
                      {r.email && <div className="text-xs font-normal text-faint">{r.email}</div>}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">
                      {r.size - r.used}/{r.size}
                      {r.amount ? <span className="ml-1 text-xs text-faint">฿{r.amount}</span> : null}
                    </td>
                    <td className="py-1 pr-2 tabular-nums">{r.expires ?? "—"}</td>
                    <td className="py-1 pr-2">{r.paid ? t("paid") : t("unpaid")}</td>
                    <td className="py-1 text-right">
                      <button type="button" className="text-xs text-faint hover:text-danger" onClick={() => drop(i)} aria-label={t("drop")}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {error && <p className="text-sm font-semibold text-danger">{error}</p>}
          <div className="flex gap-2">
            <button type="button" className="btn-primary flex-1" disabled={pending || preview.rows.length === 0} onClick={confirm} data-testid="import-confirm">
              {pending ? "…" : t("confirm", { n: preview.rows.length })}
            </button>
            <button type="button" className="btn-ghost" onClick={() => setPreview(null)}>
              {t("back")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
