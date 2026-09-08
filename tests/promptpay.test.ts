import { describe, expect, it } from "vitest";
import { crc16ccitt, parseTlv, promptPayPayload, promptPayTarget } from "@/lib/promptpay";

describe("PromptPay payloads", () => {
  it("computes CRC-16/CCITT-FALSE (check value 29B1)", () => {
    expect(crc16ccitt("123456789")).toBe("29B1");
    expect(crc16ccitt("")).toBe("FFFF");
  });

  it("recognises Thai phones, national ids and e-wallet ids", () => {
    expect(promptPayTarget("089-999-9999")).toEqual({ kind: "phone", value: "0066899999999" });
    expect(promptPayTarget("+66 89 999 9999")).toEqual({ kind: "phone", value: "0066899999999" });
    expect(promptPayTarget("1234567890123")).toEqual({ kind: "nid", value: "1234567890123" });
    expect(promptPayTarget("123456789012345")).toEqual({ kind: "ewallet", value: "123456789012345" });
    expect(promptPayTarget("12345")).toBeNull();
    expect(promptPayTarget("")).toBeNull();
  });

  it("builds a dynamic payload with the amount, in the EMVCo layout Thai banking apps scan", () => {
    const payload = promptPayPayload("0899999999", 4.22)!;
    const body = "000201" + "010212" + "2937" + "0016A000000677010111" + "01130066899999999" + "5303764" + "54044.22" + "5802TH" + "6304";
    expect(payload).toBe(body + crc16ccitt(body));
    const f = parseTlv(payload);
    expect(f["00"]).toBe("01");
    expect(f["01"]).toBe("12");
    expect(f["53"]).toBe("764");
    expect(f["54"]).toBe("4.22");
    expect(f["58"]).toBe("TH");
    expect(parseTlv(f["29"])).toEqual({ "00": "A000000677010111", "01": "0066899999999" });
    expect(f["63"]).toMatch(/^[0-9A-F]{4}$/);
    expect(f["63"]).toBe(crc16ccitt(payload.slice(0, -4)));
  });

  it("builds a static payload without an amount, and a national-id target under sub-field 02", () => {
    const payload = promptPayPayload("1234567890123")!;
    const f = parseTlv(payload);
    expect(f["01"]).toBe("11");
    expect(f["54"]).toBeUndefined();
    expect(parseTlv(f["29"])["02"]).toBe("1234567890123");
    expect(promptPayPayload("nonsense", 100)).toBeNull();
    expect(parseTlv(promptPayPayload("0812345678", 6000)!)["54"]).toBe("6000.00");
  });
});
