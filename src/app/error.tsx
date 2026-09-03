"use client";

import Link from "next/link";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 pt-10">
      <section className="card text-center">
        <div className="text-5xl">🎾</div>
        <h1 className="mt-3 text-2xl font-extrabold">Something isn&apos;t set up yet</h1>
        <p className="mt-2 text-muted">
          Usually this means the database isn&apos;t connected. Open{" "}
          <Link className="link" href="/api/health">
            /api/health
          </Link>{" "}
          for a plain-language check of what&apos;s missing.
        </p>
        <p className="mt-1 text-sm text-faint">Что-то ещё не настроено. Откройте /api/health, чтобы увидеть, чего не хватает.</p>
        <button type="button" className="btn-primary mt-5 w-full" onClick={reset}>
          Try again
        </button>
      </section>
    </main>
  );
}
