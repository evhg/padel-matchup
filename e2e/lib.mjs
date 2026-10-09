import { existsSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { createHmac } from "node:crypto";

export const BASE = process.env.BASE ?? "http://localhost:3001";
/**
 * The server under test, ready for a RegExp. A pattern that spells out "localhost:3001" passes on the
 * one port and fails, or matches somebody else's server, on any other (E2E_PORT, two gates at once).
 */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const BASE_RE = escapeRe(BASE);
export const HOST_RE = escapeRe(new URL(BASE).host);
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

/**
 * Playwright's own Chromium, unless PW_CHROMIUM names one. A container that ships a browser where
 * Playwright does not look for it (PLAYWRIGHT_BROWSERS_PATH, as the Claude Code web sessions do) is
 * found by itself, so nobody has to remember the variable.
 */
function chromiumPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const preinstalled = process.env.PLAYWRIGHT_BROWSERS_PATH ? `${process.env.PLAYWRIGHT_BROWSERS_PATH.replace(/\/$/, "")}/chromium` : null;
  return preinstalled && existsSync(preinstalled) ? preinstalled : undefined;
}

export const launch = () => chromium.launch({ executablePath: chromiumPath(), headless: true });

/**
 * One client address per suite. Every browser in the run reaches the same server from 127.0.0.1, so
 * without this all twenty-one suites share one rate-limit bucket — and `newIdentitiesPerIpPerDay` is
 * 40. The run had crept up on that ceiling: adding one player to one suite made a *different* suite's
 * create form answer "too_many" and its walk hang on a navigation that never came. Each suite gets
 * its own address, which is also what twenty-one real people look like.
 */
function suiteIp() {
  const name = (process.argv[1] ?? "suite").split("/").pop().replace(/\.mjs$/, "");
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 65521;
  return `10.31.${(h >> 8) & 255}.${(h & 255) || 7}`;
}

export const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-US", timezoneId: "Europe/Madrid", reducedMotion: "reduce", extraHTTPHeaders: { "x-forwarded-for": suiteIp() } };

/** Screenshots are optional: set SHOTS=<dir> to keep them. */
/** Switches the page's language through the header toggle. On a phone the toggle is one pill; the tap on it opens the other two. */
export async function switchLang(page, l) {
  const target = page.getByRole("button", { name: l, exact: true });
  if (!(await target.isVisible())) await page.locator('[aria-label="Language"] button[aria-pressed="true"]').click();
  await target.click();
}
/**
 * Does a day label hold the widest label its format prints, on one line, inside its box? Today's date
 * proves little: "FRI, OCT 9" fits a column that "DOM, 13 SEPT" overflows. So the label takes every day
 * of a year in English, Russian and Spanish, in the format it shows (with the weekday when its text has
 * a comma, as "Fri, Oct 9" does and "Oct 9" does not), and is measured where it stands. Its own text
 * comes back afterwards. Returns the worst label and whether it fitted.
 */
export const widestDayFits = (cell) =>
  cell.evaluate((e) => {
    const original = e.textContent;
    const opts = original.includes(",") ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" };
    const lh = parseFloat(getComputedStyle(e).lineHeight);
    let worst = { text: original, over: -Infinity, lines: 0 };
    for (const loc of ["en", "ru", "es"]) {
      const f = new Intl.DateTimeFormat(loc, { ...opts, timeZone: "UTC" });
      for (let d = 0; d < 366; d++) {
        e.textContent = f.format(new Date(Date.UTC(2026, 0, 1 + d)));
        const over = e.scrollWidth - e.clientWidth;
        const lines = Math.round(e.getBoundingClientRect().height / lh);
        if (lines > worst.lines || (lines === worst.lines && over > worst.over)) worst = { text: e.textContent, over, lines };
      }
    }
    e.textContent = original;
    return { ok: worst.over <= 0 && worst.lines <= 1, worst };
  });

/**
 * Does `inner` sit wholly inside `outer`, and on the screen? A chip pushed past its row's edge is still
 * "visible" to every other check: only the boxes say it ran off a 390px phone or was clipped.
 */
export async function sitsInside(page, inner, outer) {
  const [a, b] = [await inner.boundingBox(), await outer.boundingBox()];
  const width = page.viewportSize()?.width ?? Infinity;
  const ok = Boolean(a && b) && a.x >= b.x - 0.5 && a.y >= b.y - 0.5 && a.x + a.width <= b.x + b.width + 0.5 && a.y + a.height <= b.y + b.height + 0.5 && a.x + a.width <= width + 0.5;
  return { ok, detail: JSON.stringify({ inner: a, outer: b, width }) };
}

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

/** The webhook secret e2e/run.mjs gives the server: "e2e-resend-webhook", base64, the way Resend writes one. */
export const RESEND_WEBHOOK_SECRET = "whsec_ZTJlLXJlc2VuZC13ZWJob29r";

/** Posts an event to the Resend webhook, signed the way Resend signs it (src/lib/outreach/svix.ts). */
export async function resendEvent(page, event) {
  const body = JSON.stringify(event);
  const id = `e2e-${Math.random().toString(36).slice(2, 10)}`;
  const ts = String(Math.floor(Date.now() / 1000));
  const key = Buffer.from(RESEND_WEBHOOK_SECRET.replace(/^whsec_/, ""), "base64");
  const signature = `v1,${createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")}`;
  const res = await page.request.post(`${BASE}/api/inbound/resend`, { data: body, headers: { "content-type": "application/json", "svix-id": id, "svix-timestamp": ts, "svix-signature": signature } });
  return { status: res.status(), body: await res.json().catch(() => null) };
}
