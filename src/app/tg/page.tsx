import type { Metadata } from "next";
import Script from "next/script";
import { getTranslations } from "next-intl/server";
import { MiniAppGate } from "@/components/MiniAppGate";

export const metadata: Metadata = { title: "Kicksmash", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * The Telegram Mini App shell. Telegram opens this page inside the app with signed
 * initData; the gate posts it to /api/telegram/miniapp and moves on to the match or
 * My matches. Everything after that is the ordinary site, with the player signed in.
 */
export default async function MiniAppPage() {
  const t = await getTranslations();
  return (
    <>
      <Script src="https://telegram.org/js/telegram-web-app.js?57" strategy="beforeInteractive" />
      <MiniAppGate signingIn={t("telegram.signingIn")} notInside={t("telegram.notInside")} failed={t("telegram.invalid")} />
    </>
  );
}
