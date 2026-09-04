"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { subscribePushAction, unsubscribePushAction } from "@/actions/push";

type Status = "hidden" | "ios-needs-homescreen" | "denied" | "off" | "on" | "working";

function keyBytes(b64url: string): Uint8Array {
  const pad = "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) return existing;
  await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  return navigator.serviceWorker.ready;
}

/**
 * "Remind me 1 hour before": Web Push for all of this player's matches.
 * iPhone supports it only from a home-screen app, so the hint says so there.
 */
export function PushToggle({ vapidPublicKey, subscribed, compact = false }: { vapidPublicKey: string | null; subscribed: boolean; compact?: boolean }) {
  const t = useTranslations();
  const [status, setStatus] = useState<Status>("hidden");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!vapidPublicKey) return;
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
    const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    if (!supported) {
      setStatus(isIOS && !standalone ? "ios-needs-homescreen" : "hidden");
      return;
    }
    if (Notification.permission === "denied") {
      setStatus("denied");
      return;
    }
    let cancelled = false;
    registration()
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (cancelled) return;
        if (sub) {
          setStatus("on");
          // Keep the server copy fresh (e.g. after an identity merge).
          if (!subscribed) subscribePushAction(sub.toJSON() as Parameters<typeof subscribePushAction>[0]).catch(() => {});
        } else setStatus("off");
      })
      .catch(() => setStatus("off"));
    return () => {
      cancelled = true;
    };
  }, [vapidPublicKey, subscribed]);

  const enable = async () => {
    if (!vapidPublicKey) return;
    setError(null);
    setStatus("working");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setStatus(perm === "denied" ? "denied" : "off");
        return;
      }
      const reg = await registration();
      const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(vapidPublicKey) as BufferSource }));
      const r = await subscribePushAction(sub.toJSON() as Parameters<typeof subscribePushAction>[0]);
      if (!r.ok) throw new Error(r.error);
      setStatus("on");
    } catch (e) {
      console.warn("[push] enable failed", e);
      setError(t("common.somethingWrong"));
      setStatus("off");
    }
  };

  const disable = async () => {
    setStatus("working");
    try {
      const reg = await registration();
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await unsubscribePushAction(sub.endpoint);
        await sub.unsubscribe();
      }
    } finally {
      setStatus("off");
    }
  };

  if (status === "hidden") return null;
  if (status === "ios-needs-homescreen") return <p className={`text-sm text-muted ${compact ? "" : "rounded-2xl bg-bg px-4 py-3"}`}>🔔 {t("push.iosHint")}</p>;
  if (status === "denied") return <p className="text-sm text-muted">🔕 {t("push.denied")}</p>;
  if (status === "on") {
    return (
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="font-semibold text-ok">🔔 {t("push.on")}</span>
        <button type="button" className="shrink-0 text-xs link text-muted" onClick={disable}>
          {t("push.off")}
        </button>
      </div>
    );
  }
  return (
    <div>
      <button type="button" className={`btn-secondary ${compact ? "btn-sm" : "w-full"}`} disabled={status === "working"} onClick={enable}>
        {status === "working" ? t("common.working") : `🔔 ${t("push.enable")}`}
      </button>
      {!compact && <p className="mt-1 text-xs text-faint">{t("push.enableHelp")}</p>}
      {error && <p className="mt-1 text-sm font-semibold text-danger">{error}</p>}
    </div>
  );
}
