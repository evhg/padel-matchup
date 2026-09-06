"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type WebApp = { initData: string; initDataUnsafe?: { start_param?: string }; ready?: () => void; expand?: () => void };

/** Reads Telegram's initData, signs the player in, and leaves. A plain browser sees one line and a link. */
export function MiniAppGate({ signingIn, notInside, failed }: { signingIn: string; notInside: string; failed: string }) {
  const [state, setState] = useState<"working" | "outside" | "failed">("working");
  useEffect(() => {
    const wa = (window as unknown as { Telegram?: { WebApp?: WebApp } }).Telegram?.WebApp;
    if (!wa || !wa.initData) {
      setState("outside");
      return;
    }
    wa.ready?.();
    wa.expand?.();
    fetch("/api/telegram/miniapp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ initData: wa.initData, startParam: wa.initDataUnsafe?.start_param ?? null }) })
      .then(async (r) => {
        const j = (await r.json().catch(() => null)) as { ok?: boolean; next?: string } | null;
        if (j?.ok && j.next) window.location.replace(j.next);
        else setState("failed");
      })
      .catch(() => setState("failed"));
  }, []);
  return (
    <main className="mx-auto flex min-h-[60vh] w-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-3xl">🎾</div>
      {state === "working" && <p className="text-sm text-muted">{signingIn}</p>}
      {state === "outside" && (
        <p className="text-sm text-muted">
          {notInside}{" "}
          <Link href="/" className="link">
            kicksma.sh
          </Link>
        </p>
      )}
      {state === "failed" && <p className="text-sm text-danger">{failed}</p>}
    </main>
  );
}
