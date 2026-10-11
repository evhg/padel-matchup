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
 * whole catalogue, inline in every page's HTML: 146 KB in English, 230 KB in Russian. That slowed the
 * first paint on a busy phone, and hydration could start before the data had arrived. This provider
 * sits inside the page, not in the layout, because the layout does not render again on a client-side
 * navigation: a list picked there would follow the visitor to the next page.
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
