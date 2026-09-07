"use client";

import { useState, useTransition } from "react";
import { replyPressAction, savePressDraftAction, sendPressAction, skipPressAction } from "@/actions/press";

export type PressCardItem = {
  id: string;
  kind: string;
  moment: string | null;
  counterpartEmail: string;
  counterpartName: string | null;
  org: string | null;
  subject: string;
  body: string;
  status: string;
  notBefore: string | null;
  sentAt: string | null;
  createdAt: string;
  lastError: string | null;
};

/** One email on the desk: read it, fix the words, send or skip. English only: this is the owner's desk. */
export function PressItemCard({ item, highlight, canSend }: { item: PressCardItem; highlight: boolean; canSend: boolean }) {
  const [subject, setSubject] = useState(item.subject);
  const [body, setBody] = useState(item.body);
  const [reply, setReply] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const editable = item.kind !== "inbound" && (item.status === "draft" || item.status === "failed");
  const who = [item.counterpartName, item.org].filter(Boolean).join(" · ") || item.counterpartEmail;
  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>, done: (d: unknown) => string) =>
    start(async () => {
      setMsg(null);
      const r = await fn();
      setMsg(r.ok ? done(r.data) : `Failed: ${r.error}`);
    });
  const sendLabel = (d: unknown) => {
    const o = d as { status: string; error?: string };
    return o.status === "sent" ? "Sent." : o.status === "disabled" ? "Email is off on this deployment." : o.status === "already" ? "Already sent." : `Not sent: ${o.error ?? o.status}`;
  };
  return (
    <section className={`card ${highlight ? "ring-2 ring-accent" : ""}`} id={`item-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="chip-muted">{item.kind === "inbound" ? "📨 received" : item.kind === "reply" ? "↩️ reply" : "✉️ pitch"}</span>
        <span className="chip-muted">{item.status}</span>
        {item.moment && <span className="chip-muted">{item.moment}</span>}
        {item.notBefore && item.status === "draft" && <span className="chip-muted">not before {item.notBefore.slice(0, 10)}</span>}
        <span className="text-faint">{(item.sentAt ?? item.createdAt).slice(0, 16).replace("T", " ")}</span>
      </div>
      <div className="mt-2 text-sm">
        <span className="font-bold">{item.kind === "inbound" ? "From" : "To"}:</span> {who} <span className="text-faint">&lt;{item.counterpartEmail}&gt;</span>
      </div>
      {editable ? (
        <>
          <input className="input mt-2 w-full text-sm" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={pending} aria-label="Subject" />
          <textarea className="input mt-2 w-full text-sm" rows={Math.min(18, Math.max(6, body.split("\n").length + 1))} value={body} onChange={(e) => setBody(e.target.value)} disabled={pending} aria-label="Body" />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" className="btn-primary btn-sm" disabled={pending || !canSend} onClick={() => run(() => sendPressAction(item.id, subject, body), sendLabel)}>
              ✉️ Send
            </button>
            <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => run(() => savePressDraftAction(item.id, subject, body), () => "Saved.")}>
              Save
            </button>
            <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={() => run(() => skipPressAction(item.id), () => "Skipped.")}>
              ⏭ Skip
            </button>
            {!canSend && <span className="text-xs text-faint">Email is off (no RESEND_API_KEY).</span>}
          </div>
        </>
      ) : (
        <>
          <div className="mt-2 text-sm font-bold">{item.subject}</div>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-2xl bg-bg p-3 text-sm">{item.body}</pre>
          {item.kind === "inbound" && (
            <div className="mt-3">
              <textarea className="input w-full text-sm" rows={4} placeholder="Write a reply by hand (a drafted one may already be waiting above)" value={reply} onChange={(e) => setReply(e.target.value)} disabled={pending} aria-label="Reply" />
              <button type="button" className="btn-secondary btn-sm mt-2" disabled={pending || reply.trim().length < 2} onClick={() => run(() => replyPressAction(item.id, reply), () => "Reply drafted; it is now in the queue above.")}>
                ↩️ Draft this reply
              </button>
            </div>
          )}
        </>
      )}
      {item.lastError && <p className="mt-2 text-xs text-danger">Last error: {item.lastError}</p>}
      {msg && <p className="mt-2 text-xs text-muted">{msg}</p>}
    </section>
  );
}
