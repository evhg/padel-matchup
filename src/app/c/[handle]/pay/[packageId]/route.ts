import { and, eq } from "drizzle-orm";
import QRCode from "qrcode";
import { getDb } from "@/db";
import { lessonPackages } from "@/db/schema";
import { getCoachByHandle, getCoachQr } from "@/lib/domain/coaching";
import { promptPayPayload } from "@/lib/promptpay";

export const dynamic = "force-dynamic";

/**
 * The payment code for one package as a picture: the coach's PromptPay QR with the
 * package amount embedded, or the picture the coach uploaded. Telegram fetches it by URL.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ handle: string; packageId: string }> }) {
  const { handle, packageId } = await params;
  if (!/^[0-9a-f-]{36}$/.test(packageId)) return new Response("Not found", { status: 404 });
  const db = await getDb();
  const coach = await getCoachByHandle(db, handle.toLowerCase());
  if (!coach) return new Response("Not found", { status: 404 });
  const [pkg] = await db.select({ amount: lessonPackages.amount }).from(lessonPackages).where(and(eq(lessonPackages.id, packageId), eq(lessonPackages.coachId, coach.id))).limit(1);
  if (!pkg) return new Response("Not found", { status: 404 });
  const headers = { "cache-control": "private, max-age=300", "x-robots-tag": "noindex" };
  const uploaded = coach.qrAssetId ? await getCoachQr(db, coach.id) : null;
  if (uploaded) return new Response(new Uint8Array(uploaded.bytes), { headers: { ...headers, "content-type": uploaded.mime } });
  const payload = coach.promptpayId ? promptPayPayload(coach.promptpayId, pkg.amount) : null;
  if (!payload) return new Response("Not found", { status: 404 });
  const png = await QRCode.toBuffer(payload, { type: "png", width: 480, margin: 2, errorCorrectionLevel: "M", color: { dark: "#14161a", light: "#ffffff" } });
  return new Response(new Uint8Array(png), { headers: { ...headers, "content-type": "image/png" } });
}
