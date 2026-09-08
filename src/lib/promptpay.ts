/**
 * PromptPay QR payloads (Thailand). The EMVCo merchant-presented layout that every
 * Thai banking app scans: a chain of id-length-value fields ending in a CRC-16.
 * We only ever render the coach's own PromptPay target with an amount; no money
 * passes through Kicksmash.
 *
 * Layout (EMVCo QRCPS-MPM, as used by PromptPay):
 *   00 payload format "01"
 *   01 point of initiation: "11" static (reusable), "12" dynamic (one payment)
 *   29 merchant account: 00 AID "A000000677010111", then one of
 *        01 phone as 0066XXXXXXXXX, 02 national id / tax id (13), 03 e-wallet id (15)
 *   53 currency "764" (THB)
 *   54 amount, two decimals, only when given
 *   58 country "TH"
 *   63 CRC-16/CCITT-FALSE over everything up to and including "6304", upper-case hex
 */

export type PromptPayTarget = { kind: "phone" | "nid" | "ewallet"; value: string };

const AID = "A000000677010111";

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, "0")}${value}`;

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor. Check value for "123456789" is 29B1. */
export function crc16ccitt(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Accepts a Thai mobile number in local (08…) or international (+66 8…) form, a 13-digit id, or a 15-digit e-wallet id. */
export function promptPayTarget(raw: string): PromptPayTarget | null {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10 && digits.startsWith("0")) return { kind: "phone", value: `0066${digits.slice(1)}` };
  if (digits.length === 11 && digits.startsWith("66")) return { kind: "phone", value: `00${digits}` };
  if (digits.length === 13 && digits.startsWith("0066")) return { kind: "phone", value: digits };
  if (digits.length === 13) return { kind: "nid", value: digits };
  if (digits.length === 15) return { kind: "ewallet", value: digits };
  return null;
}

/** The full QR payload, or null when the target is not a PromptPay id we recognise. */
export function promptPayPayload(raw: string, amount?: number | null): string | null {
  const target = promptPayTarget(raw);
  if (!target) return null;
  const hasAmount = typeof amount === "number" && Number.isFinite(amount) && amount > 0;
  const subId = target.kind === "phone" ? "01" : target.kind === "nid" ? "02" : "03";
  let payload = tlv("00", "01") + tlv("01", hasAmount ? "12" : "11") + tlv("29", tlv("00", AID) + tlv(subId, target.value)) + tlv("53", "764");
  if (hasAmount) payload += tlv("54", amount.toFixed(2));
  payload += tlv("58", "TH") + "6304";
  return payload + crc16ccitt(payload);
}

/** Parses a payload back into its top-level fields; used by tests and by the settings page to show what the QR carries. */
export function parseTlv(payload: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!Number.isFinite(len)) break;
    out[id] = payload.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}
