import { describe, expect, it } from "vitest";
import { heldSeats, lineupNames, namesThatFit, PREVIEW_MAX, previewText, TELL_MAX, tellGroupText } from "@/lib/domain/groupLine";
import { formatWeekdayTime } from "@/lib/dates";
import { tagForWhatsapp, whatsappShareUrl } from "@/lib/share";

/**
 * The owner, 10 October 2026: "you have to leave the chat group". No link keeps a player inside a
 * WhatsApp group, so the trip out ends back in it: "Tell the group" after a join, and the line-up in
 * the preview under a pasted link. One line each, only what the match page already shows.
 */
describe("the line a group reads", () => {
  const roster = [
    { status: "joined", name: "Ana" },
    { status: "confirmed", name: "Bo" },
    { status: "invited", name: "Cy" },
    { status: "empty", name: null },
    { status: "declined", name: "Dee" },
  ];

  it("names the players who are in, in seat order, and never a spot held for somebody who has not said yes", () => {
    expect(lineupNames(roster)).toEqual(["Ana", "Bo"]);
    expect(heldSeats(roster)).toBe(1);
  });

  it("counts the held spots without their names, in the line and in the preview", () => {
    expect(tellGroupText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana"], capacity: 4, held: "2 held", spots: "1 spot" }, "u")).toBe("🎾 Sat 18:00 · Rawai · 1/4: Ana · 2 held · 1 spot\nu");
    expect(previewText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana"], capacity: 4, held: "2 held", spots: "1 spot" })).toBe("Ana · 2 held · 1 spot · Sat 18:00 Rawai");
  });

  it("is the line a player would type, then the match link on its own line", () => {
    const text = tellGroupText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana", "Bo", "Cy"], capacity: 4, spots: "1 spot" }, "https://kicksma.sh/7KQ2?s=wa");
    expect(text).toBe("🎾 Sat 18:00 · Rawai · 3/4: Ana, Bo, Cy · 1 spot\nhttps://kicksma.sh/7KQ2?s=wa");
  });

  it("leaves out a court nobody chose yet, and says full when it is", () => {
    expect(tellGroupText({ when: "Sat 18:00", venue: null, names: ["Ana", "Bo", "Cy", "Di"], capacity: 4, spots: "full" }, "u")).toBe("🎾 Sat 18:00 · 4/4: Ana, Bo, Cy, Di · full\nu");
  });

  it("cuts a long field to '+N', so the spots stay in sight", () => {
    const names = Array.from({ length: 24 }, (_, i) => `Player${i + 1}`);
    const text = tellGroupText({ when: "Sat 18:00", venue: "Rawai", names, capacity: 24, spots: "full" }, "u");
    const line = text.split("\n")[0];
    expect(line.length).toBeLessThanOrEqual(TELL_MAX);
    expect(line).toMatch(/24\/24: Player1, Player2, .* \+\d+ · full$/);
    expect(namesThatFit(["Ana", "Bo", "Cy"], 10)).toBe("Ana, Bo +1");
  });

  it("carries no personal link, whatever the roster holds", () => {
    const text = tellGroupText({ when: "Sat 18:00", venue: "Rawai", names: lineupNames(roster), capacity: 4, spots: "1 spot" }, "https://kicksma.sh/7KQ2?s=wa");
    expect(text).not.toMatch(/\/p\/|\/i\/|manage/);
    expect(text).not.toContain("Cy");
    expect(whatsappShareUrl(text)).toMatch(/^https:\/\/wa\.me\/\?text=/);
  });

  it("is a preview of names, spots and time within what a phone shows", () => {
    expect(previewText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana", "Bo", "Cy"], capacity: 4, spots: "1 spot" })).toBe("Ana, Bo, Cy · 1 spot · Sat 18:00 Rawai");
    const crowded = previewText({ when: "Sat 18:00", venue: "Rawai Padel Club & Fitness", names: Array.from({ length: 30 }, (_, i) => `Name${i}`), capacity: 32, spots: "2 spots" });
    expect(crowded.length).toBeLessThanOrEqual(PREVIEW_MAX);
    expect(crowded).toMatch(/\+\d+ · 2 spots · Sat 18:00 Rawai Padel Club & Fitness$/);
    // Over: no spots to offer, and nobody yet is the count alone.
    expect(previewText({ when: "Sat 18:00", venue: "Rawai", names: ["Ana"], capacity: 4, spots: null })).toBe("Ana · Sat 18:00 Rawai");
    expect(previewText({ when: "Sat 18:00", venue: null, names: [], capacity: 4, spots: "4 spots" })).toBe("4 spots · Sat 18:00");
  });

  it("says the day and time in the reader's language and the match's zone", () => {
    const at = new Date("2026-10-10T11:00:00Z"); // 18:00 in Bangkok, a Saturday
    expect(formatWeekdayTime(at, "Asia/Bangkok", "en")).toBe("Sat 18:00");
    expect(formatWeekdayTime(at, "Asia/Bangkok", "ru")).toMatch(/^сб.? 18:00$/i);
    expect(formatWeekdayTime(at, "Asia/Bangkok", "es")).toMatch(/^sáb.? 18:00$/i);
  });
});

describe("a WhatsApp link says it is one", () => {
  it("tags a bare match link ?s=wa, wherever it stands in the text", () => {
    expect(tagForWhatsapp("🎾 Padel Sat. Tap to join: https://kicksma.sh/7KQ2", "https://kicksma.sh/7KQ2")).toBe("🎾 Padel Sat. Tap to join: https://kicksma.sh/7KQ2?s=wa");
    expect(tagForWhatsapp("https://kicksma.sh/7KQ2 and again https://kicksma.sh/7KQ2.", "https://kicksma.sh/7KQ2")).toBe("https://kicksma.sh/7KQ2?s=wa and again https://kicksma.sh/7KQ2?s=wa.");
  });

  it("leaves an invitation, a link that already has a tag, and every other page as they are", () => {
    const invites = "Ana: https://kicksma.sh/7KQ2/i/abc123\nBo: https://kicksma.sh/7KQ2/i/def456";
    expect(tagForWhatsapp(invites, "https://kicksma.sh/7KQ2")).toBe(invites);
    expect(tagForWhatsapp("x https://kicksma.sh/7KQ2/card?s=card", "https://kicksma.sh/7KQ2/card?s=card")).toBe("x https://kicksma.sh/7KQ2/card?s=card");
    expect(tagForWhatsapp("Book me: https://kicksma.sh/c/olga", "https://kicksma.sh/c/olga")).toBe("Book me: https://kicksma.sh/c/olga");
  });
});
