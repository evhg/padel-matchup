/** What the bots and the mailbox say back the moment someone writes. Three languages, one voice. Nothing is promised, not even an answer: the note was read, and the person hears if something gets built. */
export type FeedbackLocale = "en" | "ru" | "es";

export const feedbackLocale = (l: string | null | undefined): FeedbackLocale => (l === "ru" || l === "es" ? l : "en");

const STRINGS = {
  en: {
    how: "Tell me what should change, in your words: /feedback and the text. I read every note, and I'll let you know if I build anything from it.",
    thanks: (name: string) => `Thanks, ${name}. I read every note myself, and I'll let you know if I build anything from it.`,
    added: "Added to your note, thank you.",
    emailSubject: "Got it, thank you",
    emailThanks: (name: string) => `Thanks, ${name}.\n\nI read every note myself. If I build anything from yours, I'll let you know here, with what changed.\n\nClaude, for Kicksmash\nhttps://kicksma.sh`,
  },
  ru: {
    how: "Напишите, что стоит изменить, своими словами: /feedback и текст. Я читаю каждое сообщение, и если что-то из этого сделаю, напишу здесь.",
    thanks: (name: string) => `Спасибо, ${name}. Я читаю каждое сообщение сам, и если что-то из этого сделаю, напишу здесь.`,
    added: "Добавил к вашей заметке, спасибо.",
    emailSubject: "Получил, спасибо",
    emailThanks: (name: string) => `Спасибо, ${name}.\n\nЯ читаю каждое сообщение сам. Если что-то из вашей заметки войдёт в Kicksmash, напишу здесь, что именно изменилось.\n\nClaude, для Kicksmash\nhttps://kicksma.sh`,
  },
  es: {
    how: "Cuéntame qué debería cambiar, con tus palabras: /feedback y el texto. Leo cada nota, y si construyo algo a partir de ella te lo diré aquí.",
    thanks: (name: string) => `Gracias, ${name}. Leo cada nota yo mismo, y si construyo algo a partir de ella te lo diré aquí.`,
    added: "Añadido a tu nota, gracias.",
    emailSubject: "Recibido, gracias",
    emailThanks: (name: string) => `Gracias, ${name}.\n\nLeo cada nota yo mismo. Si algo de la tuya entra en Kicksmash, te lo diré aquí, con lo que cambió.\n\nClaude, para Kicksmash\nhttps://kicksma.sh`,
  },
} as const;

export const feedbackStrings = (locale: string | null | undefined) => STRINGS[feedbackLocale(locale)];
