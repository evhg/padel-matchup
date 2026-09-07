/** What the bots and the mailbox say back the moment someone writes. Three languages, one voice. */
export type FeedbackLocale = "en" | "ru" | "es";

export const feedbackLocale = (l: string | null | undefined): FeedbackLocale => (l === "ru" || l === "es" ? l : "en");

const STRINGS = {
  en: {
    how: "Tell me what should change, in your words: /feedback and the text. I read every note and answer here within a day.",
    thanks: (name: string) => `Thanks, ${name}. I read every note myself and answer here within a day. Whatever you inspire, you will hear about it first.`,
    emailSubject: "Got it, thank you",
    emailThanks: (name: string) => `Thanks, ${name}.\n\nI read every note myself and answer within a day. If your idea changes Kicksmash, you will hear about it here first, with what changed.\n\nClaude, for Kicksmash\nhttps://kicksma.sh`,
  },
  ru: {
    how: "Напишите, что стоит изменить, своими словами: /feedback и текст. Я читаю каждое сообщение и отвечаю здесь в течение суток.",
    thanks: (name: string) => `Спасибо, ${name}. Я читаю каждое сообщение сам и отвечаю здесь в течение суток. Если ваша идея войдёт в продукт, вы узнаете об этом первым.`,
    emailSubject: "Получил, спасибо",
    emailThanks: (name: string) => `Спасибо, ${name}.\n\nЯ читаю каждое сообщение сам и отвечаю в течение суток. Если ваша идея изменит Kicksmash, вы узнаете об этом здесь первым, вместе с тем, что именно изменилось.\n\nClaude, для Kicksmash\nhttps://kicksma.sh`,
  },
  es: {
    how: "Cuéntame qué debería cambiar, con tus palabras: /feedback y el texto. Leo cada nota y respondo aquí en un día.",
    thanks: (name: string) => `Gracias, ${name}. Leo cada nota yo mismo y respondo aquí en un día. Si tu idea entra en el producto, serás quien lo sepa primero.`,
    emailSubject: "Recibido, gracias",
    emailThanks: (name: string) => `Gracias, ${name}.\n\nLeo cada nota yo mismo y respondo en un día. Si tu idea cambia Kicksmash, lo sabrás aquí primero, con lo que cambió.\n\nClaude, para Kicksmash\nhttps://kicksma.sh`,
  },
} as const;

export const feedbackStrings = (locale: string | null | undefined) => STRINGS[feedbackLocale(locale)];
