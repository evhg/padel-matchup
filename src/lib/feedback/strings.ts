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

/** A line that names a day, a date or an answer to come, in any of the three languages. The pool, the strings, the page copy and the model's own reply are all held to it. */
export const PROMISE_RE =
  /\bwithin\b|\btomorrow\b|\b\d+ ?(?:h|hrs?|hours?|days?|weeks?)\b|\bhear back\b|\b(?:I'll|we'll|you'll|I will|we will|you will) (?:answer|reply|respond|get back|write back)\b|\bas soon as\b|\bshortly\b|\bsoon\b|в течение|завтра|\b\d+ ?(?:ч|час|часа|часов|дн|дня|дней|сут|суток|недел)|отвечу|ответим|ответят|отвечаю|отвечают|скоро|в ближайш|\ben (?:un|una|\d+) (?:día|días|hora|horas|semana|semanas)\b|dentro de|mañana|responder(?:é|emos|án)|contestar(?:é|emos)|\bpronto\b|en breve/i;
export const promisesSomething = (line: string) => PROMISE_RE.test(line);

export const feedbackStrings = (locale: string | null | undefined) => STRINGS[feedbackLocale(locale)];
