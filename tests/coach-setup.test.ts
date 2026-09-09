import { describe, expect, it } from "vitest";
import { playerTicket, verifyPlayerTicket } from "@/lib/coach/link";
import { hoursFromLines } from "@/lib/domain/coaching";

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

  it("signs a player id for two days and refuses anything else", () => {
    const id = "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5b";
    const now = new Date("2026-09-09T12:00:00Z");
    const ticket = playerTicket(id, now);
    expect(verifyPlayerTicket(ticket, now)).toBe(id);
    expect(verifyPlayerTicket(ticket, new Date(now.getTime() + 20 * 3600_000))).toBe(id);
    expect(verifyPlayerTicket(ticket, new Date(now.getTime() + 3 * 86_400_000))).toBeNull();
    expect(verifyPlayerTicket(ticket.replace(/.$/, (c) => (c === "a" ? "b" : "a")), now)).toBeNull();
    expect(verifyPlayerTicket(ticket.replace(id, "6f1a2b3c-4d5e-4f60-8a9b-0c1d2e3f4a5c"), now)).toBeNull();
    expect(verifyPlayerTicket("nonsense", now)).toBeNull();
    expect(verifyPlayerTicket(null, now)).toBeNull();
  });
});
