import { coachStrings, type CoachBotLocale, type CoachBotStrings } from "./strings";
import type { ReplyKeyboard } from "@/lib/telegram/api";

/**
 * Buttons instead of commands. The menu sits under the text field in the
 * private chat, one for coaches and one for students, in their language; a tap
 * sends the label, which becomes the same one-line intent the parser knows.
 */
export type MenuWord = "today" | "tomorrow" | "week" | "low" | "book" | "lessons" | "left";
const LOCALES: CoachBotLocale[] = ["en", "ru", "es"];
const strip = (label: string) => label.replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();

/**
 * A tapped button, in any of the three languages, as the word the parser
 * understands; null for ordinary text. Labels match without their glyph, so a
 * typed "today" is the button too; Cancel matches only as the button itself,
 * because the bare word is the cancel intent and must stay one.
 */
export function menuWord(text: string): MenuWord | null {
  const raw = text.trim();
  const t = strip(raw);
  if (!t) return null;
  for (const locale of LOCALES) {
    const s = coachStrings(locale);
    if (raw === s.menuCancel) return "lessons";
    const table: [string, MenuWord][] = [
      [s.menuToday, "today"],
      [s.menuTomorrow, "tomorrow"],
      [s.menuWeek, "week"],
      [s.menuLow, "low"],
      [s.menuBook, "book"],
      [s.menuLessons, "lessons"],
      [s.menuLeft, "left"],
    ];
    for (const [label, word] of table) if (strip(label) === t) return word;
  }
  return null;
}

export function coachKeyboard(s: CoachBotStrings): ReplyKeyboard {
  return { keyboard: [[{ text: s.menuToday }, { text: s.menuTomorrow }], [{ text: s.menuWeek }, { text: s.menuLow }], [{ text: s.menuBook }]], is_persistent: true, resize_keyboard: true, input_field_placeholder: s.menuPlaceholder };
}

export function studentKeyboard(s: CoachBotStrings): ReplyKeyboard {
  return { keyboard: [[{ text: s.menuLessons }, { text: s.menuBook }], [{ text: s.menuLeft }, { text: s.menuCancel }]], is_persistent: true, resize_keyboard: true, input_field_placeholder: s.menuPlaceholderStudent };
}

/** Commands for the chat's "/" menu, per role, in the coach's or student's language. */
export const coachCommands = (locale: CoachBotLocale) => coachStrings(locale).commandsCoach;
export const studentCommands = (locale: CoachBotLocale) => coachStrings(locale).commandsStudent;
