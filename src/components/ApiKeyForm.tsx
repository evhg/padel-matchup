"use client";

import { useState } from "react";
import { CopyButton } from "./ShareSheet";

/** Instant key: no approval, no email verification. Shown once. */
export function ApiKeyForm() {
  const [name, setName] = useState("");
  const [agent, setAgent] = useState("");
  const [key, setKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/v1/keys", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, agent: agent || undefined }) });
      const j = await r.json();
      if (!r.ok) setError(j?.error?.message ?? "Something went wrong.");
      else setKey(j.key);
    } catch {
      setError("Network error. Try again.");
    } finally {
      setBusy(false);
    }
  };
  if (key) {
    return (
      <div className="rounded-2xl bg-accent-soft p-4">
        <div className="text-sm font-bold">Your key, shown once</div>
        <code className="mt-2 block break-all rounded-xl bg-white px-3 py-2 text-sm">{key}</code>
        <div className="mt-3 flex gap-2">
          <CopyButton value={key} label="Copy key" className="btn-secondary btn-sm" />
          <button type="button" className="btn-ghost btn-sm" onClick={() => setKey(null)}>
            Make another
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          Send it as <code>Authorization: Bearer …</code>. Lose it and just make a new one.
        </p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="grid gap-2 sm:grid-cols-2">
        <input className="input" placeholder="Who or what uses it (e.g. Thursday crew bot)" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
        <input className="input" placeholder="Assistant or product (optional, e.g. claude)" value={agent} maxLength={80} onChange={(e) => setAgent(e.target.value)} />
      </div>
      <button type="submit" className="btn-primary self-start" disabled={busy || !name.trim()}>
        {busy ? "Making…" : "Get a key"}
      </button>
      {error && <p className="text-sm font-semibold text-danger">{error}</p>}
    </form>
  );
}
