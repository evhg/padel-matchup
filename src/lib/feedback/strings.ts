/** What the bots and the mailbox say back the moment someone writes. Three languages, one voice. Nothing is promised, not even an answer: the note was read, and the person hears if something gets built. */
export type FeedbackLocale = "en" | "ru" | "es";

export const feedbackLocale = (l: string | null | undefined): FeedbackLocale => (l === "ru" || l === "es" ? l : "en");

const STRINGS = {
  en: {
    how: "Tell me what should change, in your words: /feedback and the text. I read every note, and I'll let you know if I build anything from it.",
    thanks: (name: string) => `Thanks, ${name}. I read every note myself, and I'll let you know if I build anything from it.`,
    added: "Added to your note, thank you.",
    emailSubject: "Got it, thank you",
    tooMany: "That is plenty for today. Thank you.",
  },
  ru: {
    how: "Напишите, что стоит изменить, своими словами: /feedback и текст. Я читаю каждое сообщение, и если что-то из этого сделаю, напишу здесь.",
    thanks: (name: string) => `Спасибо, ${name}. Я читаю каждое сообщение сам, и если что-то из этого сделаю, напишу здесь.`,
    added: "Добавил к вашей заметке, спасибо.",
    emailSubject: "Получил, спасибо",
    tooMany: "На сегодня достаточно. Спасибо.",
  },
  es: {
    how: "Cuéntame qué debería cambiar, con tus palabras: /feedback y el texto. Leo cada nota, y si construyo algo a partir de ella te lo diré aquí.",
    thanks: (name: string) => `Gracias, ${name}. Leo cada nota yo mismo, y si construyo algo a partir de ella te lo diré aquí.`,
    added: "Añadido a tu nota, gracias.",
    emailSubject: "Recibido, gracias",
    tooMany: "Con eso basta por hoy. Gracias.",
  },
} as const;

/**
 * Lines that name a day, a date or an answer to come, in three languages: the pool, the strings,
 * the page copy and the model's own reply are all held to them. A backstop, not a proof: tuned on
 * the phrasings in tests/feedback.test.ts, and on the reflections a scheduling app gets most
 * ("the reminder for tomorrow's match", "2 hours before"), which must pass. \b is ASCII-only, so
 * Russian words are bounded by lookarounds; the text is lowercased and its apostrophes straightened first.
 */
const PROMISE_PATTERNS: RegExp[] = [
  // English
  /\bwithin (?:a|an|one|two|three|\d+|a few|a couple of|several) (?:minute|hour|day|week|month)s?\b/,
  /\bin (?:a|an|one|two|three|a few|a couple of|several|\d+) (?:hour|day|week|month)s?\b/,
  /\b(?:next|this) (?:week|month)\b/,
  /\btomorrow\b(?!'s)/,
  /\blater today\b|\bby (?:tonight|today|the end of)\b/,
  /\bhear back\b|\bget back to you\b|\bin touch\b|\bfollow up\b/,
  /\bwill (?:answer|reply|respond|write back|get back)\b/,
  /\b(?:i'll|we'll) (?:answer|reply|respond|write back|get back|be in touch|follow up)\b/,
  /\bas soon as\b|\bshortly\b/,
  /\b(?:reply|answer|respond|write|hear|get back|be in touch)\b[^.]{0,24}\bsoon\b/,
  // Russian
  /в течение/,
  /(?<![а-яё])завтра(?![а-яё])/,
  /на днях|на этой неделе|на следующей неделе|в ближайш/,
  /через (?:\S+ )?(?:день|дня|дней|недел|час|часа|часов|минут)/,
  /отвечу|ответим|ответят|отвечаю|отвечают|дам ответ|с ответом|вернусь к вам|(?<![а-яё])скоро(?![а-яё])/,
  /сегодня (?:напишу|отвечу|ответим)|(?:напишу|отвечу|ответим) сегодня/,
  // Spanish
  /\ben (?:un|una|uno|dos|tres|unos|unas|pocos|pocas|un par de|varios|varias|\d+) (?:minutos|hora|horas|día|días|semana|semanas|mes|meses)\b/,
  /\bdentro de (?:un|una|unos|unas|poco|dos|tres|\d+)\b/,
  /(?<!\bla |\bde |\besta )\bmañana\b/,
  /\bpróxima semana\b|\besta semana\b|\blo antes posible\b|\bcuanto antes\b|\ben cuanto pueda\b|\ben breve\b|\bpronto\b/,
  /\bte (?:respondo|contesto|escribo)\b|responder(?:é|emos|án)|contestar(?:é|emos|án)|\btendrás (?:respuesta|noticias)\b|\bcon (?:una )?respuesta\b/,
];
export const promisesSomething = (line: string): boolean => {
  const s = line.replace(/[\u2018\u2019]/g, "'").toLowerCase();
  return PROMISE_PATTERNS.some((p) => p.test(s));
};

export const feedbackStrings = (locale: string | null | undefined) => STRINGS[feedbackLocale(locale)];
