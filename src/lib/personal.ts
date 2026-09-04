/** Personal link: signs the player in on any device. */
export const personalPath = (token: string) => `/p/${token}`;
export const personalUrl = (base: string, token: string) => `${base}${personalPath(token)}`;
/** Private event link: signs the device in, then opens the match. Used in calendar entries and emails. */
export const personalEventPath = (token: string, code: string) => `/p/${token}/${code}`;
export const personalEventUrl = (base: string, token: string, code: string) => `${base}${personalEventPath(token, code)}`;
