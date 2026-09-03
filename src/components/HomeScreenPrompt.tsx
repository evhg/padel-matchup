"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
const KEY = "km_a2hs_dismissed";
const SNOOZE_MS = 30 * 24 * 3600 * 1000;

/**
 * Organizer shortcut: on Android/Chrome triggers the real install prompt;
 * on iOS Safari explains the two taps. Hidden once installed or snoozed.
 */
export function HomeScreenPrompt() {
  const t = useTranslations();
  const [mode, setMode] = useState<"hidden" | "android" | "ios" | "done">("hidden");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    try {
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (standalone) return;
      const snoozed = Number(localStorage.getItem(KEY) ?? 0);
      if (snoozed && Date.now() - snoozed < SNOOZE_MS) return;
    } catch {
      return;
    }
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode("android");
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    if (isIOS && /Safari/.test(ua) && !/CriOS|FxiOS/.test(ua)) setMode("ios");
    const onInstalled = () => setMode("done");
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (mode === "hidden") return null;
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setMode("hidden");
  };
  const add = async () => {
    if (!deferred) return;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === "accepted") setMode("done");
    else dismiss();
  };

  return (
    <div className="card flex items-start gap-3 border-court/20 bg-court-soft/40 py-4 animate-pop">
      <span className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink">
        <span className="h-5 w-5 rounded-full bg-accent" />
      </span>
      <div className="min-w-0 flex-1">
        {mode === "done" ? (
          <div className="font-bold text-ok">✓ {t("homescreen.done")}</div>
        ) : (
          <>
            <div className="font-bold">{t("homescreen.title")}</div>
            <p className="mt-0.5 text-sm text-muted">{mode === "ios" ? t("homescreen.iosHint") : t("homescreen.body")}</p>
            <div className="mt-2 flex gap-2">
              {mode === "android" && (
                <button type="button" className="btn-secondary btn-sm" onClick={add}>
                  {t("homescreen.add")}
                </button>
              )}
              <button type="button" className="btn-ghost btn-sm" onClick={dismiss}>
                {t("homescreen.later")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
