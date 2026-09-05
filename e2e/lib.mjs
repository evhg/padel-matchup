import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

export const BASE = process.env.BASE ?? "http://localhost:3001";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Uses the Playwright-managed Chromium, or PW_CHROMIUM when a preinstalled binary should be used. */
export const launch = () => chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, headless: true });

export const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "Europe/Madrid" };

/** Screenshots are optional: set SHOTS=<dir> to keep them. */
export const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());

export function makeCheck(results) {
  return (name, cond, extra = "") => {
    results.push({ name, ok: !!cond });
    console.log((cond ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
  };
}

export function finish(results) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed: " + failed.map((r) => r.name).join(" | "));
  process.exit(failed.length ? 1 : 0);
}
