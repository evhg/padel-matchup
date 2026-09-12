import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

export const BASE = process.env.BASE ?? "http://localhost:3001";
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/** Uses the Playwright-managed Chromium, or PW_CHROMIUM when a preinstalled binary should be used. */
export const launch = () => chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined, headless: true });

export const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "Europe/Madrid", reducedMotion: "reduce" };

/** Screenshots are optional: set SHOTS=<dir> to keep them. */
export const shot = (page, name) => (SHOTS ? page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }) : Promise.resolve());

export function makeCheck(results) {
  return (name, cond, extra = "") => {
    results.push({ name, ok: !!cond });
    console.log((cond ? "✓ " : "✗ ") + name + (extra ? " — " + extra : ""));
  };
}

/** A crash is only diagnosable with the scene: every open page's address and first lines, and a screenshot of each when SHOTS is set. */
export async function crashed(browser, results, e, name = "crash") {
  console.error("✗ crashed:", e);
  let i = 0;
  for (const ctx of browser.contexts()) {
    for (const page of ctx.pages()) {
      i++;
      let text = "(no text)";
      try {
        text = (await page.locator("body").innerText({ timeout: 2000 })).replace(/\s+/g, " ").slice(0, 400);
      } catch {}
      console.error(`  page ${i} at ${page.url()}: ${text}`);
      try {
        await shot(page, `${name}-${i}`);
      } catch {}
    }
  }
  results.push({ name, ok: false });
}

export function finish(results) {
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) console.log("failed: " + failed.map((r) => r.name).join(" | "));
  process.exit(failed.length ? 1 : 0);
}

/**
 * A lesson day that exists whatever day the suite runs on: the first Monday to Friday at least two days
 * out (so a day-boundary skew between this process and the coach's zone can never make it "today"),
 * with the word the assistant understands for it in each language. Coaches' hours are off at weekends
 * by default, so "tomorrow" from a Friday or a Saturday finds nothing.
 */
export function lessonDay(now = new Date()) {
  const words = {
    en: ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"],
    ru: ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"],
    es: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
  };
  for (let offset = 2; offset <= 6; offset++) {
    const d = new Date(now.getTime() + offset * 86400000);
    const dow = d.getUTCDay();
    if (dow >= 1 && dow <= 5) return { offset, date: d.toISOString().slice(0, 10), en: words.en[dow], ru: words.ru[dow], es: words.es[dow] };
  }
  throw new Error("unreachable: five weekdays in any six days");
}
