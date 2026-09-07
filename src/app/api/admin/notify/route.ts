import { NextResponse } from "next/server";
import { operatorAuthorized } from "@/lib/api/secret";
import { ownerTelegramId } from "@/lib/listen/tick";
import { esc, sendMessage, telegramEnabled } from "@/lib/telegram/api";

export const dynamic = "force-dynamic";

/**
 * A line to the owner's Telegram, for the operator jobs that have no bot token
 * of their own (the daily fixer, the uptime probe). Bearer CRON_SECRET.
 *   POST /api/admin/notify { text, url?, label? }
 * Text is sent as-is (escaped); one optional button.
 */
export async function POST(req: Request) {
  if (!operatorAuthorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const owner = ownerTelegramId();
  if (!owner || !telegramEnabled()) return NextResponse.json({ error: "telegram_not_configured" }, { status: 503 });
  const body = (await req.json().catch(() => ({}))) as { text?: unknown; url?: unknown; label?: unknown; silent?: unknown };
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 3500) : "";
  if (!text) return NextResponse.json({ error: "text required" }, { status: 400 });
  const url = typeof body.url === "string" && /^https:\/\//.test(body.url) ? body.url.slice(0, 500) : null;
  const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 40) : "Open";
  const res = await sendMessage(owner, esc(text), { silent: body.silent === true, ...(url ? { keyboard: { inline_keyboard: [[{ text: label, url }]] } } : {}) });
  return NextResponse.json({ ok: res.ok }, { status: res.ok ? 200 : 502 });
}
