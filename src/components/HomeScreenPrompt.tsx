"use client";

import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };
const DONE_KEY = "km_a2hs_done";
const ARRIVE_FLAG = "a2hs";

type Mode = "hidden" | "prompt" | "ios-steps" | "android-steps" | "done";

/**
 * Home-screen shortcut that opens the player's personal link. Shown until a
 * shortcut exists: hidden when running from one (standalone), when the server
 * saw a shortcut visit for this player (`installed`), when Android reports the
 * PWA installed, or once the user walked through the steps on this browser.
 * No "Not now": either add it or ignore it.
 */
export function HomeScreenPrompt({ personalPath, installed = false }: { personalPath?: string | null; installed?: boolean }) {
  const t = useTranslations();
  const pathname = usePathname();
  const [mode, setMode] = useState<Mode>("hidden");
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [platform, setPlatform] = useState<"ios" | "android" | "other">("other");
  const [safari, setSafari] = useState(true);

  useEffect(() => {
    if (installed) return;
    let standalone = false;
    let doneHere = false;
    let arrived = false;
    try {
      standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      doneHere = localStorage.getItem(DONE_KEY) === "1";
      const sp = new URLSearchParams(window.location.search);
      arrived = sp.get(ARRIVE_FLAG) === "1";
      if (arrived) {
        sp.delete(ARRIVE_FLAG);
        const q = sp.toString();
        window.history.replaceState(null, "", window.location.pathname + (q ? `?${q}` : "") + window.location.hash);
      }
    } catch {
      /* storage unavailable */
    }
    if (standalone || doneHere) return;
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isAndroid = /Android/i.test(ua);
    const p = isIOS ? "ios" : isAndroid ? "android" : "other";
    setPlatform(p);
    setSafari(isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua));

    let cancelled = false;
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
      setMode((m) => (m === "hidden" && !cancelled ? "prompt" : m));
    };
    const onInstalled = () => setMode("done");
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);

    const show = () => {
      if (arrived) setMode(p === "ios" ? "ios-steps" : "android-steps");
      else if (p === "ios" || p === "android") setMode("prompt");
    };
    // Android Chrome can tell us the PWA is already installed.
    const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
    if (nav.getInstalledRelatedApps) {
      nav
        .getInstalledRelatedApps()
        .then((apps) => {
          if (cancelled) return;
          if (apps.length > 0) cancelled = true;
          else show();
        })
        .catch(show);
    } else show();

    return () => {
      cancelled = true;
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, [installed]);

  if (mode === "hidden") return null;

  const finish = () => {
    try {
      localStorage.setItem(DONE_KEY, "1");
    } catch {
      /* ignore */
    }
    setMode("hidden");
  };

  const add = async () => {
    if (deferred) {
      await deferred.prompt();
      const { outcome } = await deferred.userChoice;
      if (outcome === "accepted") setMode("done");
      else setDeferred(null);
      return;
    }
    // No install API: make sure the shortcut will point at the personal link, then show the two taps.
    if (personalPath && pathname !== personalPath) {
      window.location.assign(`${personalPath}?${ARRIVE_FLAG}=1`);
      return;
    }
    setMode(platform === "ios" ? "ios-steps" : "android-steps");
  };

  return (
    <div className="card flex items-start gap-3 border-court/20 bg-court-soft/40 py-4 animate-pop">
      <span className="inline-grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-ink">
        <span className="h-5 w-5 rounded-full bg-accent" />
      </span>
      <div className="min-w-0 flex-1">
        {mode === "done" && <div className="font-bold text-ok">✓ {t("homescreen.done")}</div>}
        {mode === "prompt" && (
          <>
            <div className="font-bold">{t("homescreen.title")}</div>
            <p className="mt-0.5 text-sm text-muted">{t("homescreen.body")}</p>
            <button type="button" className="btn-secondary btn-sm mt-2" onClick={add}>
              {t("homescreen.add")}
            </button>
          </>
        )}
        {(mode === "ios-steps" || mode === "android-steps") && (
          <>
            <div className="font-bold">{mode === "ios-steps" ? t("homescreen.iosTitle") : t("homescreen.title")}</div>
            <p className="mt-0.5 text-sm text-muted">{mode === "ios-steps" ? (safari ? t("homescreen.iosSteps") : `${t("homescreen.notSafari")} ${t("homescreen.iosSteps")}`) : t("homescreen.androidSteps")}</p>
            <div className="mt-2 flex gap-2">
              {deferred && (
                <button type="button" className="btn-secondary btn-sm" onClick={add}>
                  {t("homescreen.add")}
                </button>
              )}
              <button type="button" className="btn-ghost btn-sm" onClick={finish}>
                {t("homescreen.gotIt")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
