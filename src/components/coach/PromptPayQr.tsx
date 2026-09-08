"use client";

import { QRCodeSVG } from "qrcode.react";
import { promptPayPayload } from "@/lib/promptpay";

/**
 * The coach's own payment code: a PromptPay QR rendered from their number with the
 * amount embedded, or the picture their bank gave them. Nothing passes through us.
 */
export function PromptPayQr({ promptpayId, amount, imageUrl, size = 200 }: { promptpayId?: string | null; amount?: number | null; imageUrl?: string | null; size?: number }) {
  // Their bank's own picture, shown as uploaded: no optimisation, no remote loader.
  // eslint-disable-next-line @next/next/no-img-element
  if (imageUrl) return <img src={imageUrl} alt="" width={size} height={size} className="rounded-xl border border-line bg-white object-contain" />;
  const payload = promptpayId ? promptPayPayload(promptpayId, amount ?? null) : null;
  if (!payload) return null;
  return (
    <div className="inline-block rounded-xl border border-line bg-white p-2">
      <QRCodeSVG value={payload} size={size} level="M" bgColor="#ffffff" fgColor="#14161a" marginSize={1} />
    </div>
  );
}
