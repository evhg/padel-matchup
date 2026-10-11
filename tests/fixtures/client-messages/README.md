# The client-messages guard's own fixture

A small app tree that `tests/client-messages.test.ts` walks with `analyseClientMessages(table, src)`.
Each page here hides a translator in a way the guard once missed (the review of 11 October 2026), and
the test names what the guard must say about it. Nothing here runs: the build and the real walk read
`src/` only. The TypeScript files must still pass `pnpm typecheck`, so each one is code that the
compiler accepts and that would show a message key as text in the browser.
