import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { players } from "@/db/schema";
import { ALL_CHANNELS } from "@/lib/channels";
import { baseUrl, emailEnabled, emailFrom, ownerTelegramId } from "@/lib/config";
import { pushEnabled } from "@/lib/push";
import { databaseSource, onVercel, sessionSecretSource } from "@/lib/env";
import { telegramEnabled } from "@/lib/telegram/api";
import { whatsappEnabled } from "@/lib/whatsapp/api";

export const dynamic = "force-dynamic";

/**
 * Plain-language setup check. Safe to share: never returns secrets.
 * Open https://kicksma.sh/api/health after deploying.
 */
export async function GET() {
  const source = databaseSource();
  let database: "connected" | "error" | "missing" | "embedded" = source === "missing" ? "missing" : source === "embedded" ? "embedded" : "error";
  let databaseError: string | null = null;
  if (source !== "missing") {
    try {
      const db = await getDb();
      await db.execute(sql`select 1`);
      database = source === "embedded" ? "embedded" : "connected";
    } catch (e) {
      database = "error";
      databaseError = e instanceof Error ? e.message : String(e);
    }
  }
  const placeholderLeft = /\[YOUR-PASSWORD\]/.test(process.env.DATABASE_URL ?? "") && !process.env.DATABASE_PASSWORD;

  const hints: string[] = [];
  if (database === "missing") hints.push("Add DATABASE_URL in Vercel → Project → Settings → Environment Variables, then Deployments → Redeploy.");
  if (placeholderLeft) hints.push("DATABASE_URL still contains [YOUR-PASSWORD]. Either replace it, or add a DATABASE_PASSWORD variable and redeploy.");
  if (database === "error") hints.push("The database URL is set but the connection failed. Check the password and that the host ends with pooler.supabase.com:6543.");
  if (database === "embedded" && onVercel()) hints.push("Embedded database cannot run on Vercel. Set DATABASE_URL.");
  if (!pushEnabled()) hints.push("Push reminders are off (no VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY). Generate a pair with `npx web-push generate-vapid-keys`.");
  if (!emailEnabled()) hints.push("Email is off (no RESEND_API_KEY). Everything else works; add it later for calendar invites and notifications.");
  if (!process.env.CRON_SECRET) hints.push("CRON_SECRET is not set; the cron endpoint is unauthenticated but harmless. Set it when convenient.");

  // Four chat channels shipped and this page could not say whether any of them was on. The card
  // channels answer for themselves through the registry, so a fifth needs no line here; WhatsApp is
  // not a card channel and is asked separately.
  const channels: Record<string, "on" | "off"> = { whatsapp: whatsappEnabled() ? "on" : "off" };
  for (const c of ALL_CHANNELS) channels[c.name] = c.enabled() ? "on" : "off";
  const off = Object.entries(channels).filter(([, v]) => v === "off").map(([k]) => k);
  if (off.length > 0) hints.push(`These chat channels are off because their keys are not set: ${off.join(", ")}. Everything else works without them.`);

  // Feedback, the listening desk, uptime and production errors all reach one person down one route.
  // If either half of it is missing, a note a player writes is stored and nobody is told.
  const ownerId = ownerTelegramId();
  const ownerRoute = telegramEnabled() && ownerId !== null;
  if (!ownerRoute) {
    hints.push(
      telegramEnabled()
        ? "Nothing reaches the owner: TELEGRAM_OWNER_ID is not set, so feedback, uptime and error alerts are written down and never delivered."
        : "Nothing reaches the owner: the Telegram bot is off, so feedback, uptime and error alerts are written down and never delivered.",
    );
  }
  // Whose account, not whether one is set. "It reaches the owner: true" was true and useless on the
  // morning a player received an internal verdict on his own note, meant for the owner alone and
  // ending "say build or skip in your Claude session" — TELEGRAM_OWNER_ID named him. A first name is
  // what the public shapes already carry (rule 6), and it is the thing that would have been noticed.
  let owner: string | null = null;
  // Either kind of working database, not just the hosted one: an embedded deployment has an owner too.
  if (ownerRoute && (database === "connected" || database === "embedded")) {
    const [row] = await (await getDb()).select({ name: players.displayName }).from(players).where(eq(players.telegramId, ownerId)).limit(1).catch(() => [] as { name: string }[]);
    owner = row?.name ?? null;
    if (owner) hints.push(`Everything meant for the owner goes to the Telegram account of ${owner}. If that is not you, change TELEGRAM_OWNER_ID.`);
  }

  const ok = database === "connected" || (database === "embedded" && !onVercel());
  return NextResponse.json(
    {
      ok,
      database,
      databaseSource: source,
      databaseError,
      sessionSecret: sessionSecretSource(),
      cronSecret: process.env.CRON_SECRET ? "set" : "missing",
      email: emailEnabled() ? "enabled" : "disabled",
      push: pushEnabled() ? "enabled" : "disabled",
      channels,
      feedbackReachesOwner: ownerRoute,
      owner,
      emailFrom: emailEnabled() ? emailFrom() : null,
      baseUrl: baseUrl(),
      hints,
    },
    { status: ok ? 200 : 503 },
  );
}
