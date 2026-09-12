import { afterAll, beforeAll, vi } from "vitest";

/**
 * Pins the clock of a test file to one instant, so a test written on a Tuesday still runs on a Saturday.
 *
 * Only `Date` is faked: timers, promises and PGlite keep running for real. Every `new Date()` and
 * `Date.now()` in the domain then agrees with the `NOW` the test passes around, which is what the
 * domain's `now = new Date()` defaults assume. Database defaults such as `created_at` still use the
 * database's own clock; a test that compares one with `NOW` sets the column explicitly.
 *
 * Call it once at the top of a file that declares a fixed `NOW`:
 *
 *   const NOW = new Date("2026-09-08T09:00:00Z");
 *   freezeClock(NOW);
 */
export function freezeClock(at: Date): void {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at);
  });
  afterAll(() => {
    vi.useRealTimers();
  });
}
