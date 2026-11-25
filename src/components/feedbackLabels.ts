/** Every word the feedback form shows, read on the server and handed to the form as props (`FeedbackForm`). */
export const FEEDBACK_KEYS = ["title", "placeholder", "contactLabel", "contactHelp", "send", "sent", "tooShort", "tooMany", "notSent", "viaTelegram", "viaEmail", "notFeedback", "tryAgain", "shotAdd", "shotAlt", "shotRemove", "shotBad"] as const;
export type FeedbackLabels = Record<(typeof FEEDBACK_KEYS)[number], string>;

/** `t` is `getTranslations("feedback")`, or anything that answers its keys. */
export function feedbackLabels(t: (key: (typeof FEEDBACK_KEYS)[number]) => string): FeedbackLabels {
  return Object.fromEntries(FEEDBACK_KEYS.map((k) => [k, t(k)])) as FeedbackLabels;
}
