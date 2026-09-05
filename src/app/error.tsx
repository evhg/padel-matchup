"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Count it on /admin; no personal data leaves the browser.
    fetch("/api/client-error", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ digest: error.digest ?? "", message: error.message?.slice(0, 200) ?? "" }) }).catch(() => {});
  }, [error]);
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-10">
      <section className="card text-center">
        <div className="text-5xl">🎾</div>
        <h1 className="mt-3 text-2xl font-extrabold">Net cord. Something went wrong.</h1>
        <p className="mt-2 text-muted">We&apos;ve logged it. Try again; if it keeps happening, the status page at /api/health says what&apos;s up.</p>
        <p className="mt-1 text-sm text-faint">Algo ha fallado · Что-то пошло не так</p>
        <div className="mt-5 flex gap-2">
          <button type="button" className="btn-primary flex-1" onClick={reset}>
            Try again
          </button>
          <Link className="btn-ghost" href="/" prefetch={false}>
            Home
          </Link>
        </div>
      </section>
    </main>
  );
}
