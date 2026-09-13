/** A browser hint's attributes, in one place: a year, readable by the page's script, never a credential. */
export const hintCookieOptions = () => ({ httpOnly: false, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 365 * 24 * 3600 });
