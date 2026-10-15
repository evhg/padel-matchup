import { describe, expect, it } from "vitest";
import { mailLine, stayUpdated, welcomeKind } from "@/lib/domain/stayUpdated";

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

/**
 * What a saved address gets at once, which is also what the card says went out (15 October 2026: on the
 * waiting list the card said "Calendar invite sent" while the email held only the personal link). Each
 * line changes one thing from a seated player on a deployment that sends mail.
 */
describe("the welcome a saved address gets", () => {
  const seated = { emailOn: true, seated: true, cancelled: false, byNameOnly: false };
  it("a seat in a match that is on: the calendar invitation", () => {
    expect(welcomeKind(seated)).toBe("invite");
  });
  it("no seat (the waiting list), or a match called off: the personal-link email, and no invitation", () => {
    expect(welcomeKind({ ...seated, seated: false })).toBe("link");
    expect(welcomeKind({ ...seated, cancelled: true })).toBe("link");
  });
  it("a deployment that sends no mail, or no address: nothing", () => {
    expect(welcomeKind({ ...seated, emailOn: false })).toBeNull();
  });
  it("a session by name that proved nothing: nothing, seated or not, because both mails carry the personal link (DECIDING rule 34)", () => {
    expect(welcomeKind({ ...seated, byNameOnly: true })).toBeNull();
    expect(welcomeKind({ ...seated, seated: false, byNameOnly: true })).toBeNull();
  });
});

/**
 * What a card says about the address on file (the "Stay updated" card and the invitation page's form ask
 * this one rule). Before a save on the card, the page's word (`invited`); after it, the save's own answer.
 * 15 October 2026: the invitation page said "Calendar invite sent" after a save that sent nothing.
 */
describe("the mail line a card shows", () => {
  const at = "ana@example.com";
  it("no address: no line, whatever else is true", () => {
    expect(mailLine({ sentTo: null, invited: true, welcome: undefined })).toBeNull();
    expect(mailLine({ sentTo: null, invited: true, welcome: "invite" })).toBeNull();
  });
  it("before a save: the invitation line only where the page says the address brought it", () => {
    expect(mailLine({ sentTo: at, invited: true, welcome: undefined })).toBe("invite");
    // The waiting list, a session by name, or no mail: an address on file, and no word of an invitation.
    expect(mailLine({ sentTo: at, invited: false, welcome: undefined })).toBeNull();
  });
  it("after a save: what the save answered, whatever the page said before", () => {
    expect(mailLine({ sentTo: at, invited: false, welcome: "invite" })).toBe("invite");
    expect(mailLine({ sentTo: at, invited: true, welcome: "link" })).toBe("link");
    // A session by name, seated (invited false) or not: the save sent nothing, so nothing is said.
    expect(mailLine({ sentTo: at, invited: false, welcome: null })).toBeNull();
    expect(mailLine({ sentTo: at, invited: true, welcome: null })).toBeNull();
  });
});
