import { describe, expect, it } from "vitest";
import { coachCommands, coachKeyboard, menuWord, studentCommands, studentKeyboard } from "@/lib/coach/menu";
import { coachStrings } from "@/lib/coach/strings";

describe("the bot's menu buttons", () => {
  it("turns a tapped label, in any language, into the word the parser reads", () => {
    expect(menuWord("📅 Today")).toBe("today");
    expect(menuWord("Tomorrow")).toBe("tomorrow");
    expect(menuWord("Week")).toBe("week");
    expect(menuWord("Almost out")).toBe("low");
    expect(menuWord("＋ Book")).toBe("book");
    expect(menuWord("🎾 My lessons")).toBe("lessons");
    expect(menuWord("Package left")).toBe("left");
    expect(menuWord("✕ Cancel")).toBe("lessons");
    expect(menuWord("📅 Сегодня")).toBe("today");
    expect(menuWord("＋ Записать")).toBe("book");
    expect(menuWord("Casi sin clases")).toBe("low");
    expect(menuWord("Mañana")).toBe("tomorrow");
    // Ordinary lines stay ordinary.
    expect(menuWord("anna fri 15")).toBeNull();
    expect(menuWord("today")).toBe("today");
    expect(menuWord("")).toBeNull();
  });

  it("builds the two keyboards from the strings and names the commands per role", () => {
    for (const locale of ["en", "ru", "es"] as const) {
      const s = coachStrings(locale);
      const c = coachKeyboard(s);
      expect(c.keyboard.flat().map((b) => b.text)).toEqual([s.menuToday, s.menuTomorrow, s.menuWeek, s.menuLow, s.menuBook]);
      expect(c.is_persistent).toBe(true);
      const st = studentKeyboard(s);
      expect(st.keyboard.flat().map((b) => b.text)).toEqual([s.menuLessons, s.menuBook, s.menuLeft, s.menuCancel]);
      // Every button round-trips through the parser's word.
      for (const b of [...c.keyboard.flat(), ...st.keyboard.flat()]) expect(menuWord(b.text)).not.toBeNull();
      expect(coachCommands(locale).map((x) => x.command)).toEqual(["today", "week", "coach", "help"]);
      expect(studentCommands(locale).map((x) => x.command)).toEqual(["lessons", "help"]);
    }
  });
});
