import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, loadMessages, negotiateLocale, toLocale } from "./config";

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const hdrs = await headers();
  const locale = toLocale(cookieStore.get(LOCALE_COOKIE)?.value) ?? negotiateLocale(hdrs.get("accept-language"));
  const tz = hdrs.get("x-vercel-ip-timezone") ?? "UTC";
  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: tz,
    now: new Date(),
  };
});
