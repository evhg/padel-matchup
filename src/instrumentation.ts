import type { Instrumentation } from "next";

/**
 * Next.js calls this for every error a request throws on the server and nobody caught: a page or a
 * layout that fails to render, a route handler, a server action outside `run()`, the middleware.
 * Until 15 October 2026 nothing listened, so a crash of the match page reached the error store only
 * as the browser's report: a message Next.js had already replaced with a generic line, and a client
 * row, which never alerts the owner (`recordAndAlert` in `src/lib/alerts.ts`).
 *
 * Now the error goes to the store as a `server` row with its own message and stack, and the owner's
 * Telegram hears about it the way every server error is heard about: once for an error the store has
 * never seen or that came back after a fix, never for a repeat, and at most `ERROR_ALERTS.perHour`
 * lines an hour whatever happens. A crash loop is one fingerprint, so it is one line.
 *
 * The hook loads in every server function (AGENTS.md rule 12), so it imports nothing at the top: the
 * alerts module comes in only when an error happens, and only on Node.js, where the store is.
 */

/** Errors Next.js throws on purpose: a redirect, `notFound()`, a page that must render dynamically, a client-side bailout. */
const CONTROL_FLOW = ["NEXT_REDIRECT", "NEXT_HTTP_ERROR_FALLBACK", "NEXT_NOT_FOUND", "DYNAMIC_SERVER_USAGE", "BAILOUT_TO_CLIENT_SIDE_RENDERING"];

/**
 * The copy of a server component's error that the HTML pass meets: Next.js has already replaced its
 * message with this sentence, and the error itself reached this hook from the server component pass,
 * under the same digest. On a production build one crash of `/m/<id>` came twice, as the real message
 * and as this one (15 October 2026), and the copy would have spent one of the hour's alert lines.
 */
const OBFUSCATED = "The specific message is omitted in production builds";

const digestOf = (err: unknown): string | null => {
  const d = err && typeof err === "object" ? (err as { digest?: unknown }).digest : null;
  return typeof d === "string" ? d : null;
};

export const onRequestError: Instrumentation.onRequestError = async (err, request) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const digest = digestOf(err);
    if (digest && CONTROL_FLOW.some((c) => digest.startsWith(c))) return;
    if (err instanceof Error && err.message.includes(OBFUSCATED)) return;
    try {
      const { later, reportError } = await import("@/lib/alerts");
      // Held open after the answer, as every report is: React does not wait for this hook.
      await later(() => reportError("server", err, { path: request.path, digest }));
    } catch {
      /* the report never becomes a second error */
    }
  }
};
