"use client";

import { useState, useTransition } from "react";
import { approveListenAction, markListenPostedAction, saveListenDraftAction, skipListenAction } from "@/actions/listen";

export type ListenCardItem = {
  id: string;
  source: string;
  url: string;
  title: string;
  body: string;
  author: string | null;
  postedAt: string;
  status: string;
  kind: string | null;
  language: string | null;
  draft: string | null;
  draftReason: string | null;
  replyUrl: string | null;
  lastError: string | null;
  canPost: boolean;
};

/** One drafted reply: read the thread, fix the words, approve or skip. English only: this is the owner's desk. */
export function ListenItemCard({ item, highlight }: { item: ListenCardItem; highlight: boolean }) {
  const [draft, setDraft] = useState(item.draft ?? "");
  const [replyUrl, setReplyUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const open = item.status === "drafted" || item.status === "approved" || item.status === "failed";
  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, done: (d: unknown) => string) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r.ok ? done(r.data) : `Failed: ${r.error}`);
    });
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setMsg("Copy failed; select the text instead.");
    }
  };
  return (
    <article id={item.id} className={`card ${highlight ? "ring-2 ring-accent" : ""}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span className="chip-muted uppercase">{item.source}</span>
        <span className={`chip-muted ${item.status === "posted" ? "text-ok" : item.status === "failed" ? "text-danger" : ""}`}>{item.status}</span>
        {item.kind && <span>{item.kind.replace(/_/g, " ")}</span>}
        {item.language && <span>· {item.language}</span>}
        <span>· {new Date(item.postedAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}</span>
        {item.author && <span>· {item.author}</span>}
      </div>
      <h2 className="mt-2 font-extrabold">
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="link">
          {item.title}
        </a>
      </h2>
      <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{item.body.slice(0, 700)}{item.body.length > 700 ? "…" : ""}</p>
      {item.draftReason && <p className="mt-2 text-xs text-faint">Why: {item.draftReason}</p>}
      {open ? (
        <>
          <label className="label mt-3 block">Reply {/kicksma\.sh/i.test(draft) && <span className="chip-muted ml-1 normal-case">mentions kicksma.sh</span>}</label>
          <textarea className="input min-h-32 w-full text-sm" value={draft} maxLength={1500} onChange={(e) => setDraft(e.target.value)} />
          <div className="mt-2 flex flex-wrap gap-2">
            {item.status !== "approved" && (
              <button type="button" className="btn-primary btn-sm" disabled={pending || !draft.trim()} onClick={() =>
                  run(
                    () => approveListenAction(item.id, draft),
                    (d) => {
                      const r = d as { status?: string; url?: string } | undefined;
                      return r?.status ? `Done: ${r.status}${r.url ? ` · ${r.url}` : ""}` : "Done";
                    },
                  )
                }
              >
                {item.canPost ? "Approve & post" : "Approve"}
              </button>
            )}
            <button type="button" className="btn-secondary btn-sm" disabled={pending} onClick={() => run(() => saveListenDraftAction(item.id, draft), () => "Saved")}>
              Save
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={copy}>
              {copied ? "Copied ✓" : "Copy"}
            </button>
            <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => run(() => skipListenAction(item.id), () => "Skipped")}>
              Skip
            </button>
          </div>
          {!item.canPost && (
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                run(() => markListenPostedAction(item.id, replyUrl), () => "Marked as posted");
              }}
            >
              <label className="block flex-1">
                <span className="label">Posted it yourself? Paste the link</span>
                <input className="input w-full text-sm" value={replyUrl} onChange={(e) => setReplyUrl(e.target.value)} placeholder="https://…" />
              </label>
              <button type="submit" className="btn-secondary btn-sm" disabled={pending}>
                Mark posted
              </button>
            </form>
          )}
        </>
      ) : (
        <>
          {item.draft && <p className="mt-3 whitespace-pre-wrap rounded-2xl bg-bg p-3 text-sm">{item.draft}</p>}
          {item.replyUrl && (
            <a href={item.replyUrl} target="_blank" rel="noopener noreferrer" className="link mt-2 inline-block text-sm">
              Our reply →
            </a>
          )}
        </>
      )}
      {item.lastError && <p className="mt-2 text-xs text-danger">{item.lastError}</p>}
      {msg && <p className="mt-2 text-sm font-semibold">{msg}</p>}
    </article>
  );
}
