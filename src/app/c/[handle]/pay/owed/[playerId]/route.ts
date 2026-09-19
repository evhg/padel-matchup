import QRCode from "qrcode";
import { getDb } from "@/db";
import { getCoachByHandle, getCoachQr, owedBy } from "@/lib/domain/coaching";
import { promptPayPayload } from "@/lib/promptpay";

export const dynamic = "force-dynamic";

/**
 * What one student still owes a coach, as a picture: the coach's PromptPay QR with that sum
 * embedded, or the picture the coach uploaded. Telegram fetches it by URL under the "Pay" tap.
 * Unclaimed lessons and open packages count; a lesson the student says they paid does not.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ handle: string; playerId: string }> }) {
  const { handle, playerId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(playerId)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const coach = await getCoachByHandle(db, handle.toLowerCase());
  if (!coach) return new Response("Not found", { status: 404 });
  const owed = await owedBy(db, coach, playerId);
  const due = owed.lessons.filter((l) => !l.claimedAt).reduce((a, l) => a + l.amount, 0) + owed.packages.reduce((a, p) => a + p.amount, 0);
  if (due <= 0) return new Response("Not found", { status: 404 });
  const headers = { "cache-control": "private, max-age=60", "x-robots-tag": "noindex" };
  const uploaded = coach.qrAssetId ? await getCoachQr(db, coach.id) : null;
  if (uploaded) return new Response(new Uint8Array(uploaded.bytes), { headers: { ...headers, "content-type": uploaded.mime } });
  const payload = coach.promptpayId ? promptPayPayload(coach.promptpayId, due) : null;
  if (!payload) return new Response("Not found", { status: 404 });
  const png = await QRCode.toBuffer(payload, { type: "png", width: 480, margin: 2, errorCorrectionLevel: "M", color: { dark: "#14161a", light: "#ffffff" } });
  return new Response(new Uint8Array(png), { headers: { ...headers, "content-type": "image/png" } });
}
