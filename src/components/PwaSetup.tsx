"use client";

import { useEffect } from "react";
import { markHomescreenAction } from "@/actions/push";

const PROBE_KEY = "km_standalone_seen";

/**
 * Registers the push service worker and, when the page runs from a
 * home-screen shortcut, tells the server once so the prompt stops showing.
 */
export function PwaSetup({ signedIn }: { signedIn: boolean }) {
  useEffect(() => {
    if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    try {
      const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
      if (!standalone || !signedIn || sessionStorage.getItem(PROBE_KEY)) return;
      sessionStorage.setItem(PROBE_KEY, "1");
      markHomescreenAction().catch(() => {});
    } catch {
      /* storage unavailable */
    }
  }, [signedIn]);
  return null;
}
