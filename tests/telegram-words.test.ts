import { describe, expect, it } from "vitest";
import { readWords } from "@/lib/telegram/words";

/**
 * The word reader: what a line typed in a crew's chat means, in English, Russian and Spanish.
 *
 * The whole message is the word, never a part of it. A join that came from ordinary chat is a seat
 * taken in somebody's name, so the tables below are written from the side of "never": every line in
 * `chat` must stay null, and a new phrase is added only with the sentences it must not swallow.
 */
const cases = (kind: string, lines: string[]) => lines.map((line) => [kind, line] as const);

describe("readWords: join, leave, a score, a new match, or nothing", () => {
  it.each([
    ...cases("join", ["in", "IN", "In!", "I'm in", "i’m in 🎾", "IM IN!!!", "I am in.", "+1", "+ 1", "+", "+1 🙋‍♂️", "me", "Me!", "count me in", "Count me in 💪", "я", "Я!", "я в деле", "Я в деле 🔥", "в деле", "voy", "¡Voy!", "me apunto", "Me apunto 💪", "yo voy", "cuenta conmigo"]),
    ...cases("leave", ["out", "OUT", "I'm out", "im out 😔", "-1", "−1", "can't make it", "Can’t make it, sorry", "cant make it", "I can't make it", "count me out", "не смогу", "Не смогу 😔", "я не смогу", "минус", "Минус.", "пас", "no puedo", "No puedo 😢", "me bajo", "Me bajo!", "no voy"]),
    ...cases("score", ["6-4 6-3", "6:4, 3:6, 7-5", " 6-4 "]),
  ])("%s ← %j", (kind, line) => {
    expect(readWords(line)?.kind).toBe(kind);
  });

  it("an ask is a question with a time in it, and its words are handed on whole", () => {
    for (const line of ["who's in Thursday 7pm Rawai?", "Who’s in tomorrow 19:00?", "WHO IS IN sat 10:00 Bangtao", "anyone for tmr 18:00?", "Кто играет завтра в 19:00 Равай?", "кто в деле чт 20:00", "¿Quién juega mañana a las 19 Rawai?", "quien se apunta el jueves 20:00"]) {
      const w = readWords(line);
      expect(w?.kind, line).toBe("ask");
      expect(w && w.kind === "ask" ? w.text : null).toBe(line.trim());
    }
  });

  it.each([
    // Ordinary chat that starts or ends like a word: never a join, never a leave.
    "in the car, 5 min",
    "I'm in Rawai today",
    "I'm in traffic",
    "in 10 minutes",
    "me and Bea are late",
    "count me in for dinner",
    "+1 to that idea",
    "+100",
    "me too",
    "я тоже",
    "я опоздаю",
    "я в пути",
    "yo también",
    "yo",
    "voy tarde",
    "out of balls, bring some",
    "out now",
    "I'm out of the office",
    "can't wait",
    "не смогу найти корт",
    "no puedo creerlo",
    "minus the rain it was great",
    "6-4 6-3 what a game",
    "the score was 6-4",
    // An ask without a time is a question about the card, not a new match.
    "who's in?",
    "who's in tomorrow?",
    "кто играет?",
    "¿quién juega?",
    // Nothing at all.
    "",
    "   ",
    "🎾",
    "👍",
    "?",
    "ok",
  ])("null ← %j", (line) => {
    expect(readWords(line)).toBeNull();
  });

  it("refuses a long message outright, whatever it ends with", () => {
    expect(readWords(`${"blah ".repeat(60)}in`)).toBeNull();
    expect(readWords(undefined)).toBeNull();
  });
});
