/**
 * The text of a `<script type="application/ld+json">` tag, safe for words that people typed.
 *
 * `JSON.stringify` keeps `<` as it is, and React writes `dangerouslySetInnerHTML` into the page as it
 * is. A browser ends a script tag at the first `</script>` it reads, also inside a JSON string. So a
 * competition named `</script><img src=x onerror=…>` (anybody can make one, with no sign-in) ran its
 * own script on /t/<slug> for every visitor until 11 October 2026. The same was true of a coach's name
 * on /c/<handle>, /coaches and /coaches/<city>, and of a series' name on /s/<slug>. Such a script reads
 * the visitor's restore seal (`IdentitySync`) and their personal link from /me, and so becomes them.
 *
 * Here `<`, `>` and `&` become JSON escapes, and so do the two line separators that end a line in old
 * JavaScript. A JSON reader gets the same value back. `tests/json-ld.test.ts` fails on a
 * `dangerouslySetInnerHTML` anywhere in src/ that does not go through this function.
 */
export function jsonLdHtml(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
