import { and, eq } from "drizzle-orm";
import type { Db } from "@/db";
import { metricsDaily } from "@/db/schema";
import { bumpMetric, dayKey } from "@/lib/domain/metrics";
import type { EventDetail } from "@/lib/domain/queries";
import { whenLine, whereLine } from "@/lib/telegram/card";
import catalogue from "../../../data/whatsapp-templates.json";
import { sendTemplateMessage, whatsappEnabled, type WaResult } from "./api";

/**
 * What WhatsApp carries to a player who is not in the middle of a conversation with us.
 *
 * A player who linked WhatsApp on the match page's "Stay updated" card was promised that the match's
 * changes, a free spot and the result card reach them there (the owner's decision of 26 September
 * 2026). Outside the 24-hour window a person opens by writing to us, WhatsApp delivers only a message
 * template Meta has approved, so each of those four notices is one template in
 * `data/whatsapp-templates.json`, in English, Russian and Spanish.
 *
 * Every one is a UTILITY template. Meta charges per delivered template, but a utility template sent
 * inside an open window is free, and a marketing one never is. So nothing here tracks the window: a
 * utility template costs nothing where a free reply would have been possible, and the price of one
 * outside it where nothing else could arrive at all.
 *
 * A template's buttons survive a forward, so a button here never carries a personal link: the URL
 * button's variable part is a match code (`7KQ2`, or `7KQ2/card`), which `templatePayload` refuses
 * to be anything else.
 */

export type WaLocale = "en" | "ru" | "es";
export type WaTemplateName = "ks_match_update" | "ks_spot_open" | "ks_score_ask" | "ks_match_result";

/** What a sender fills in: the body's variables in order, the URL button's end, a quick reply's payload, the header picture. */
export type WaTemplateParts = { body: string[]; button?: string; quickReply?: string; image?: string };

type WaTemplateButton = { type: "URL"; url: string; example: string } | { type: "QUICK_REPLY" };
type WaTemplateLanguage = { body: string; example: string[]; buttons: string[] };
export type WaTemplateDef = { name: WaTemplateName; category: "UTILITY" | "MARKETING"; header?: "IMAGE"; buttons: WaTemplateButton[]; languages: Record<WaLocale, WaTemplateLanguage> };

export const WA_TEMPLATES = catalogue.templates as unknown as WaTemplateDef[];
export const WA_LOCALES: WaLocale[] = ["en", "ru", "es"];

/** The player's language as a template language: Russian and Spanish have their own, everybody else reads English. */
export const waLocale = (locale: string | null | undefined): WaLocale => (locale?.startsWith("ru") ? "ru" : locale?.startsWith("es") ? "es" : "en");

/** The variable numbers in a body, in the order they appear: `[1, 2]` for "…{{1}}…{{2}}…". */
export const variablesOf = (body: string): number[] => [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));

/** A URL button's variable part: a four-letter match code, or one and `/card`. Anything else could be a personal link or a token. */
const PUBLIC_SUFFIX = /^[A-Za-z0-9]{4}(?:\/card)?$/;

/** Meta refuses a variable with a newline, a tab or four spaces in a row, and an empty one. */
function param(value: string): string {
  const v = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return v ? v.slice(0, 200) : "–";
}

/** "Sat, Sep 27 · 18:00 · Rawai Padel · Court 3": the match as every template's first variable names it. */
export const waMatchLine = (detail: EventDetail, locale: WaLocale): string => `${whenLine(detail, locale)} · ${whereLine(detail, locale)}`;

/**
 * The Cloud API's `template` object for one send. Throws when the parts do not fit the template —
 * a missing variable, a picture the header needs, or a button end that is not a match code — so a
 * message Meta would refuse, or one that would carry a sign-in link, is never sent at all.
 */
export function templatePayload(name: WaTemplateName, locale: string | null | undefined, parts: WaTemplateParts) {
  const def = WA_TEMPLATES.find((t) => t.name === name);
  if (!def) throw new Error(`whatsapp template ${name}: not in data/whatsapp-templates.json`);
  const code = waLocale(locale);
  const lang = def.languages[code];
  const wanted = new Set(variablesOf(lang.body)).size;
  if (parts.body.length !== wanted) throw new Error(`whatsapp template ${name}: ${wanted} body values wanted, ${parts.body.length} given`);
  const components: Record<string, unknown>[] = [];
  if (def.header === "IMAGE") {
    if (!parts.image || !/^https?:\/\//.test(parts.image)) throw new Error(`whatsapp template ${name}: the header needs a picture`);
    components.push({ type: "header", parameters: [{ type: "image", image: { link: parts.image } }] });
  }
  components.push({ type: "body", parameters: parts.body.map((text) => ({ type: "text", text: param(text) })) });
  def.buttons.forEach((b, i) => {
    if (b.type === "QUICK_REPLY") {
      if (!parts.quickReply) throw new Error(`whatsapp template ${name}: the quick reply needs its payload`);
      components.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: parts.quickReply }] });
      return;
    }
    if (!b.url.includes("{{1}}")) return;
    // A forwarded message keeps its buttons: the variable part is a match code, never a personal link.
    if (!parts.button || !PUBLIC_SUFFIX.test(parts.button)) throw new Error(`whatsapp template ${name}: a button opens a public match page only`);
    components.push({ type: "button", sub_type: "url", index: String(i), parameters: [{ type: "text", text: parts.button }] });
  });
  return { name, language: { code }, components };
}

const DEFAULT_PER_DAY = 50;

/**
 * How many templates the deployment may send in one UTC day: `WHATSAPP_TEMPLATES_PER_DAY`, 50 when
 * unset, and 0 switches template sends off. This is the cost guard. Meta bills each template it
 * delivers outside an open window, and nothing else here bounds how many a busy day could ask for.
 */
export function waTemplatesPerDay(): number {
  const raw = process.env.WHATSAPP_TEMPLATES_PER_DAY;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PER_DAY;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, n) : DEFAULT_PER_DAY;
}

/** Whether WhatsApp can carry a notice at all: the thread is configured and the day's cap is not switched to zero. */
export const whatsappNotices = (): boolean => whatsappEnabled() && waTemplatesPerDay() > 0;

async function sentToday(db: Db, day: string): Promise<number> {
  const [row] = await db
    .select({ n: metricsDaily.value })
    .from(metricsDaily)
    .where(and(eq(metricsDaily.day, day), eq(metricsDaily.key, "whatsapp_templates")))
    .limit(1);
  return Number(row?.n ?? 0);
}

/**
 * One template to one number. Never throws: a refusal comes back as `{ ok: false }`, so every caller
 * can fall through to email or push, as `tell()` does.
 *
 * The count is read, then the message is sent, then the count is bumped. Two sends at the same moment
 * can both read 49 and both go, so the cap can be passed by the few sends in flight at once. At this
 * volume that is a message or two, and a lock would cost more than it saves.
 */
export async function sendWaTemplate(db: Db, to: string, name: WaTemplateName, locale: string | null | undefined, parts: WaTemplateParts, now = new Date()): Promise<WaResult> {
  try {
    if (!whatsappEnabled()) return { ok: false, status: 0, error: "whatsapp disabled" };
    const day = dayKey(now);
    const cap = waTemplatesPerDay();
    if (cap <= 0 || (await sentToday(db, day)) >= cap) {
      await bumpMetric(db, "whatsapp_templates_capped", 1, day).catch(() => undefined);
      return { ok: false, status: 0, error: "daily cap" };
    }
    const res = await sendTemplateMessage(to.replace(/\D/g, ""), templatePayload(name, locale, parts));
    // Only a message Meta took counts towards the cap: a refused one is not billed.
    if (res.ok) await bumpMetric(db, "whatsapp_templates", 1, day).catch(() => undefined);
    return res;
  } catch (e) {
    return { ok: false, status: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
