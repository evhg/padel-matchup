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

/** A tapped button, in any of the three languages, as the word the parser understands; null for ordinary text. */
export function menuWord(text: string): MenuWord | null {
  const t = strip(text);
  if (!t) return null;
  for (const locale of LOCALES) {
    const s = coachStrings(locale);
    const table: [string, MenuWord][] = [
      [s.menuToday, "today"],
      [s.menuTomorrow, "tomorrow"],
      [s.menuWeek, "week"],
      [s.menuLow, "low"],
      [s.menuBook, "book"],
      [s.menuLessons, "lessons"],
      [s.menuLeft, "left"],
      [s.menuCancel, "lessons"],
    ];
    for (const [label, word] of table) if (strip(label) === t) return word;
  }
  return null;
}

/** The parser's canonical English token for a menu word (the parser reads all three languages, English is enough). */
export const menuToLine = (word: Exclude<MenuWord, "book">): string => word;

export function coachKeyboard(s: CoachBotStrings): ReplyKeyboard {
  return { keyboard: [[{ text: s.menuToday }, { text: s.menuTomorrow }], [{ text: s.menuWeek }, { text: s.menuLow }], [{ text: s.menuBook }]], is_persistent: true, resize_keyboard: true, input_field_placeholder: s.menuPlaceholder };
}

export function studentKeyboard(s: CoachBotStrings): ReplyKeyboard {
  return { keyboard: [[{ text: s.menuLessons }, { text: s.menuBook }], [{ text: s.menuLeft }, { text: s.menuCancel }]], is_persistent: true, resize_keyboard: true, input_field_placeholder: s.menuPlaceholderStudent };
}

/** Commands for the chat's "/" menu, per role. */
export const coachCommands = (locale: CoachBotLocale) =>
  locale === "ru"
    ? [
        { command: "today", description: "Занятия сегодня" },
        { command: "week", description: "Неделя" },
        { command: "coach", description: "Открыть ассистента" },
        { command: "help", description: "Что я умею" },
      ]
    : locale === "es"
      ? [
          { command: "today", description: "Clases de hoy" },
          { command: "week", description: "La semana" },
          { command: "coach", description: "Abrir mi asistente" },
          { command: "help", description: "Qué hago" },
        ]
      : [
          { command: "today", description: "Today's lessons" },
          { command: "week", description: "The week" },
          { command: "coach", description: "Open my assistant" },
          { command: "help", description: "What I do" },
        ];

export const studentCommands = (locale: CoachBotLocale) =>
  locale === "ru"
    ? [
        { command: "lessons", description: "Мои занятия и абонемент" },
        { command: "help", description: "Что я умею" },
      ]
    : locale === "es"
      ? [
          { command: "lessons", description: "Mis clases y mi bono" },
          { command: "help", description: "Qué hago" },
        ]
      : [
          { command: "lessons", description: "My lessons and package" },
          { command: "help", description: "What I do" },
        ];
