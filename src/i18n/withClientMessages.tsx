import type { ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { getMessages } from "next-intl/server";
import { pickMessages, ROOT_CLIENT_MESSAGES, type ClientPath } from "./clientMessages";

/**
 * A page's default export, whose client components get the messages they read and no others.
 *
 *   export default withClientMessages(["common", "me"], MePage);
 *
 * The root layout gives the browser ROOT_CLIENT_MESSAGES (nothing). Before 11 October 2026 it gave the
 * whole catalogue, inline in every page's HTML and again in every refresh: 146 KB in English, 230 KB in
 * Russian. This provider sits inside the page, not in the layout, because the layout does not render
 * again on a client-side navigation: a list picked there would follow the visitor to the next page.
 *
 * The price, measured on production builds (bytes, main -> this): a client-side navigation into a
 * wrapped page now carries the page's list, where the catalogue never travelled twice. /me -> a match
 * by its Link: en 23,242 -> 70,574, ru 24,095 -> 101,043. Against it: the first load of /me saves
 * 116,041 (en) and 184,174 (ru), and a live night's 20-second refresh of a match page drops from
 * 162,447 to 73,661 (en) and from 248,017 to 104,267 (ru). A session with no refresh comes out behind
 * main from the third Link tap into a match in English, and from the second round trip to a match and
 * back in Russian. A base given once by the layout (common, errors, identity, level, share, feedback:
 * 10 KB en, 16 KB ru) would take about a fifth off each such tap, and would add those bytes to every
 * first load and refresh of a page that reads less, so it is not done.
 *
 * A smaller page narrows the window in which hydration can start before the page's rows arrive (the
 * HTML before /me can hydrate: en 176,867 -> 60,377 bytes). It does not fix React error 418 on /me:
 * with the document paused part-way, both builds still throw it (ROADMAP.md, "Open, small").
 *
 * Server components still read the whole catalogue through the request config. Locale, time zone and
 * `now` come from the request config, as before. tests/client-messages.test.ts reads every list back
 * from the source and prints the right one when a list is wrong.
 */
export function withClientMessages<P extends object>(paths: readonly ClientPath[], Page: (props: P) => ReactNode | Promise<ReactNode>) {
  return async function WithClientMessages(props: P) {
    return (
      <NextIntlClientProvider messages={pickMessages(await getMessages(), [...ROOT_CLIENT_MESSAGES, ...paths])}>
        <Page {...props} />
      </NextIntlClientProvider>
    );
  };
}
