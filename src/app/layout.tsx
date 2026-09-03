import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import { IdentitySync } from "@/components/IdentitySync";
import { getDb } from "@/db";
import { APP_NAME, APP_TAGLINE, baseUrl } from "@/lib/config";
import { getSessionPlayer } from "@/lib/session";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: APP_TAGLINE,
  metadataBase: new URL(baseUrl()),
  applicationName: APP_NAME,
  appleWebApp: { capable: true, title: APP_NAME, statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  themeColor: "#f4f3ee",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  const messages = await getMessages();
  let me: { id: string; name: string } | null = null;
  try {
    const db = await getDb();
    const p = await getSessionPlayer(db);
    if (p) me = { id: p.id, name: p.displayName };
  } catch (e) {
    console.error("[layout] db unavailable", e);
  }
  return (
    <html lang={locale}>
      <body className="min-h-dvh">
        {/* Per-user manifest: start_url is the visitor's personal link, so a home-screen shortcut is always signed in. */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <NextIntlClientProvider messages={messages}>
          {children}
          <IdentitySync player={me} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
