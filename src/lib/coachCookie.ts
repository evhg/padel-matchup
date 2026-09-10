/** A browser hint, not a permission: the header shows the assistant link to a coach without a database read on every page. */
export const COACH_COOKIE = "km_coach";

/** A browser hint's attributes, in one place: a year, readable by the page's script, never a credential. */
export const hintCookieOptions = () => ({ httpOnly: false, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 365 * 24 * 3600 });
export const coachCookieOptions = hintCookieOptions;
