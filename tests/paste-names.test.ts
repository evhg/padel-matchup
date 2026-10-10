import { describe, expect, it } from "vitest";
import { namesFromChat, PASTE_NAMES_MAX, planPaste } from "@/lib/domain/pasteNames";

/**
 * "Paste the names from the group": what the organiser copies out of the crew's WhatsApp group, in
 * the three languages the app speaks, and what comes out of it. Chat that is not a name is dropped,
 * never kept as one.
 */
describe("names from a group chat", () => {
  it("reads a numbered list, one name per line, '+1' and emoji (en)", () => {
    expect(namesFromChat("1. Ana 2. Bo")).toEqual(["Ana", "Bo"]);
    expect(namesFromChat("+1 Cy")).toEqual(["Cy"]);
    expect(namesFromChat("Ana\nBo +1\n✅ Cy\nDi 🎾\n- Jean-Luc\n• O'Neil\n3) Eve")).toEqual(["Ana", "Bo", "Cy", "Di", "Jean-Luc", "O'Neil", "Eve"]);
    expect(namesFromChat("Ana, Bo, Cy")).toEqual(["Ana", "Bo", "Cy"]);
    expect(namesFromChat("Gil+1")).toEqual(["Gil"]);
  });

  it("drops what is chat, not a name (en)", () => {
    expect(namesFromChat("Who's in Saturday?\ncan't make it\nmaybe\nRawai at 6\nI'm in\nAna (maybe)\nBo +2")).toEqual([]);
    expect(namesFromChat("Ana, Bo and me")).toEqual(["Ana"]);
  });

  it("reads Russian lists and copied messages, and drops Russian chat", () => {
    expect(namesFromChat("1. Аня\n2. Борис\n+1 Катя 🎾")).toEqual(["Аня", "Борис", "Катя"]);
    expect(namesFromChat("[10.10.2026, 18:02:11] Аня: +\n[10.10.2026, 18:05:00] Борис: буду\n[10.10.2026, 18:06:00] Олег: не смогу")).toEqual(["Аня", "Борис"]);
    expect(namesFromChat("не смогу\nя буду\nкто играет?")).toEqual([]);
  });

  it("reads Spanish lists and copied messages, and drops Spanish chat", () => {
    expect(namesFromChat("José María +1\n✅ Lucía\nno puedo\n¿Quién juega?")).toEqual(["José María", "Lucía"]);
    expect(namesFromChat("[10/10/26, 6:02:15 p. m.] Pepe: voy\n10/10/26, 18:02 - Marta: yo\n10/10/26, 18:03 - Juan: hoy no puedo")).toEqual(["Pepe", "Marta"]);
  });

  it("takes a sender who answered with an emoji, and the names inside the organiser's own list", () => {
    expect(namesFromChat("[10/10/26, 18:02] Nok: 👍\n[10/10/26, 18:03] Org: 1. Pim 2. Ton")).toEqual(["Nok", "Pim", "Ton"]);
  });

  it("keeps each name once, in its first spelling, and at most a field's worth", () => {
    expect(namesFromChat("Ana\nana\nANA \n Bo")).toEqual(["Ana", "Bo"]);
    const many = Array.from({ length: 40 }, (_, i) => `Player${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`).join("\n");
    expect(namesFromChat(many).length).toBe(PASTE_NAMES_MAX);
  });

  it("holds a spot per name while spots last, skips a name already in the match, and names who found no spot", () => {
    expect(planPaste(["Ana", "bo", "Cy", "Di"], ["Bo", "Dana"], 2)).toEqual({ hold: ["Ana", "Cy"], already: ["bo"], noSpot: ["Di"] });
    expect(planPaste(["Ana"], [], 0)).toEqual({ hold: [], already: [], noSpot: ["Ana"] });
  });
});
