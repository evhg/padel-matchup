import { describe, expect, it } from "vitest";
import { stayUpdated } from "@/lib/domain/stayUpdated";

/**
 * The "stay updated" card a player meets the moment they join (the owner, 25 September 2026): which
 * choices it offers, and when it stops asking. Push is never one of them, and a channel counts only
 * where the deployment runs it.
 */
const none = { email: null, telegramId: null, phone: null };
const all = { whatsapp: true, telegram: true, email: true };

describe("the stay-updated card", () => {
  it("asks a player with no channel, offering what the deployment runs, WhatsApp then Telegram then email", () => {
    expect(stayUpdated(none, all)).toEqual({ kind: "ask", choices: ["whatsapp", "telegram", "email"] });
    // No WhatsApp number yet (the owner's Meta account): two choices, in the same order.
    expect(stayUpdated(none, { ...all, whatsapp: false })).toEqual({ kind: "ask", choices: ["telegram", "email"] });
    expect(stayUpdated(none, { whatsapp: false, telegram: false, email: true })).toEqual({ kind: "ask", choices: ["email"] });
  });

  it("is not there at all on a deployment that runs none of the three (rule 4)", () => {
    expect(stayUpdated(none, { whatsapp: false, telegram: false, email: false })).toEqual({ kind: "hidden" });
  });

  it("never asks again once one channel is linked, and says which", () => {
    expect(stayUpdated({ ...none, telegramId: 42 }, all)).toEqual({ kind: "reached", via: ["telegram"], calendar: "feed" });
    expect(stayUpdated({ ...none, phone: "+66810000001" }, all)).toEqual({ kind: "reached", via: ["whatsapp"], calendar: "feed" });
    expect(stayUpdated({ ...none, email: "a@b.co", telegramId: 42 }, all)).toEqual({ kind: "reached", via: ["telegram", "email"], calendar: "invite" });
  });

  it("keeps an email player's calendar on the invitation, so no match lands in the calendar twice", () => {
    expect(stayUpdated({ ...none, email: "a@b.co" }, all)).toEqual({ kind: "reached", via: ["email"], calendar: "invite" });
  });

  it("counts a channel only where the deployment runs it: an address nobody sends to is no channel", () => {
    // An address on a deployment without email, a Telegram id where the bot is gone: the card asks.
    expect(stayUpdated({ ...none, email: "a@b.co" }, { ...all, email: false })).toEqual({ kind: "ask", choices: ["whatsapp", "telegram"] });
    expect(stayUpdated({ ...none, telegramId: 42 }, { ...all, telegram: false })).toEqual({ kind: "ask", choices: ["whatsapp", "email"] });
    expect(stayUpdated({ ...none, phone: "+66810000001" }, { ...all, whatsapp: false })).toEqual({ kind: "ask", choices: ["telegram", "email"] });
  });
});
