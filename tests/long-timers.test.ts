import { describe, expect, it } from "vitest";

/**
 * Node turns a delay longer than 2^31 - 1 ms into 1 ms. PGlite asks for such a delay under a frozen
 * clock, and the timer then fired every millisecond while a test waited (tests/helpers/setup.ts says
 * how). The setup caps the delay instead, so a timer that far out waits, as it asked to.
 */
describe("a timer longer than Node can hold", () => {
  it("waits, and does not fire after 1 ms", async () => {
    let fired = 0;
    const t = setTimeout(() => fired++, 2 ** 32);
    await new Promise((r) => setTimeout(r, 50));
    clearTimeout(t);
    expect(fired).toBe(0);
  });

  it("leaves an ordinary delay alone", async () => {
    let fired = 0;
    setTimeout(() => fired++, 5);
    await new Promise((r) => setTimeout(r, 40));
    expect(fired).toBe(1);
  });
});
