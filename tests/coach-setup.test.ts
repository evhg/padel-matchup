import { describe, expect, it } from "vitest";
import { playerTicket, ticketPlayerId, verifyPlayerTicket } from "@/lib/coach/link";
import { hoursFromLines, isPayLink } from "@/lib/domain/coaching";
import { mintTicket, readTicket, ticketSubject } from "@/lib/ticket";

describe("the setup's hours and the bot link ticket", () => {
  it("turns seven lines into hours, or names the first bad day", () => {
    const ok = hoursFromLines(["off", "08:00-20:00", "08:00-20:00", "07:00-12:00, 15:00-20:00", "08:00-20:00", "08:00-20:00", "09:00-13:00"]);
    expect(ok.invalidDay).toBeNull();
    expect(ok.hours!["0"]).toEqual([]);
    expect(ok.hours!["3"]).toEqual([["07:00", "12:00"], ["15:00", "20:00"]]);
    expect(ok.hours!["6"]).toEqual([["09:00", "13:00"]]);
    const bad = hoursFromLines(["off", "08:00-20:00", "20:00-08:00", "off", "off", "off", "off"]);
    expect(bad.hours).toBeNull();
    expect(bad.invalidDay).toBe(2);
    expect(hoursFromLines([]).invalidDay).toBeNull();
  });

  it("fits a Telegram start parameter: with its prefix at most 64 characters of letters, digits, underscore and dash", () => {
    const id = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
    const ticket = playerTicket({ id, telegramId: null });
    const param = `coach_${ticket}`;
    expect(param.length).toBeLessThanOrEqual(64);
    expect(param).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(ticketPlayerId(ticket)).toBe(id);
  });

  it("signs a player for two days, dies the moment an account is bound, and refuses anything else", () => {
    const id = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
    const now = new Date("2026-09-09T12:00:00Z");
    const unbound = { id, telegramId: null };
    const ticket = playerTicket(unbound, now);
    expect(verifyPlayerTicket(ticket, unbound, now)).toBe(true);
    expect(verifyPlayerTicket(ticket, unbound, new Date(now.getTime() + 20 * 3600_000))).toBe(true);
    expect(verifyPlayerTicket(ticket, unbound, new Date(now.getTime() + 3 * 86_400_000))).toBe(false);
    // Bound since: the same ticket no longer verifies; a fresh one for the bound player does.
    const bound = { id, telegramId: 616161 };
    expect(verifyPlayerTicket(ticket, bound, now)).toBe(false);
    expect(verifyPlayerTicket(playerTicket(bound, now), bound, now)).toBe(true);
    // Tampering and strangers.
    expect(verifyPlayerTicket(ticket.replace(/.$/, (c) => (c === "a" ? "b" : "a")), unbound, now)).toBe(false);
    expect(verifyPlayerTicket(ticket, { id: "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5c", telegramId: null }, now)).toBe(false);
    expect(ticketPlayerId("nonsense")).toBeNull();
    expect(ticketPlayerId(null)).toBeNull();
    expect(verifyPlayerTicket(null, unbound, now)).toBe(false);
  });

  it("day tickets read back their subject only with the same secret and salt", () => {
    const now = new Date("2026-09-09T12:00:00Z");
    const t = mintTicket("s1", "1545987795863085090", { now });
    expect(ticketSubject(t)).toBe("1545987795863085090");
    expect(readTicket("s1", t, { now })).toBe("1545987795863085090");
    expect(readTicket("s2", t, { now })).toBeNull();
    expect(readTicket("s1", t, { salt: "x", now })).toBeNull();
    expect(readTicket("s1", "abc.1.x", { now })).toBeNull();
    expect(readTicket("s1", `${"a".repeat(65)}_1_${"0".repeat(16)}`, { now })).toBeNull();
  });

  it("knows a payment link from a phone number", () => {
    expect(isPayLink("https://promptpay.io/0812345678")).toBe(true);
    expect(isPayLink("http://pay.example/abc")).toBe(true);
    expect(isPayLink("promptpay.io/0812345678")).toBe(false);
    expect(isPayLink("https://a b")).toBe(false);
    expect(isPayLink("")).toBe(false);
  });
});
