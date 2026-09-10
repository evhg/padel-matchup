/** Personal link: signs the player in on any device. */
export const personalPath = (token: string) => `/p/${token}`;
export const personalUrl = (base: string, token: string) => `${base}${personalPath(token)}`;
/** Private event link: signs the device in, then opens the match. Used in calendar entries and emails. */
export const personalEventPath = (token: string, code: string) => `/p/${token}/${code}`;
export const personalEventUrl = (base: string, token: string, code: string) => `${base}${personalEventPath(token, code)}`;

/** The one place a personal link may send the device on to: an internal path (`/coach`, a match code, which may start with a digit, a series page), never a host, a query or anything longer than the longest route we mint. */
export const safeNext = (next: string | null | undefined): string | null => (next && /^\/[a-z0-9][a-z0-9/_-]{0,79}$/i.test(next) ? next : null);
