import { NextResponse, type NextRequest } from "next/server";
import { LOCALE_COOKIE } from "@/i18n/config";

/**
 * Language paths for search engines: /ru/... and /es/... serve the same pages in
 * Russian and Spanish. The language is otherwise a cookie, invisible to crawlers;
 * the prefix makes it a URL that can rank, be linked and carry hreflang. The
 * request is rewritten to the plain path with an x-locale header the i18n
 * config reads first, and the cookie is set so the next unprefixed click stays
 * in that language.
 */
export function middleware(req: NextRequest) {
  const m = req.nextUrl.pathname.match(/^\/(ru|es)(\/.*)?$/);
  if (!m) return NextResponse.next();
  const locale = m[1];
  const url = req.nextUrl.clone();
  url.pathname = m[2] && m[2] !== "/" ? m[2] : "/";
  const headers = new Headers(req.headers);
  headers.set("x-locale", locale);
  const res = NextResponse.rewrite(url, { request: { headers } });
  if (req.cookies.get(LOCALE_COOKIE)?.value !== locale) res.cookies.set(LOCALE_COOKIE, locale, { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax" });
  return res;
}

export const config = { matcher: ["/ru", "/ru/:path*", "/es", "/es/:path*"] };
