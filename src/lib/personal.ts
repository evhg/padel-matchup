/** Personal link: signs the player in on any device. */
export const personalPath = (token: string) => `/p/${token}`;
export const personalUrl = (base: string, token: string) => `${base}${personalPath(token)}`;
