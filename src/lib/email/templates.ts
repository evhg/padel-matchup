import { createTranslator } from "next-intl";
import { loadMessages, toLocale, type Locale } from "@/i18n/config";
import { APP_NAME } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import type { Event } from "@/db/schema";

export type Rendered = { subject: string; html: string; text: string };

export async function translatorFor(localeLike: string | null | undefined) {
  const locale: Locale = toLocale(localeLike) ?? "en";
  const messages = await loadMessages(locale);
  return { t: createTranslator({ locale, messages }), locale };
}

export function eventVars(ev: Pick<Event, "startsAt" | "tz" | "venueName">, locale: string, venueFallback = "TBD") {
  return {
    day: formatEventDay(ev.startsAt, ev.tz, locale),
    time: formatEventTime(ev.startsAt, ev.tz, locale),
    venue: ev.venueName ?? venueFallback,
  };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type LayoutInput = {
  heading: string;
  body: string;
  meta?: { label: string; value: string }[];
  cta?: { label: string; url: string };
  secondary?: { label: string; url: string };
  footer: string;
  eventUrl: string;
  openLabel: string;
  personal?: { label: string; url: string };
};

export function layout(i: LayoutInput): { html: string; text: string } {
  const meta = (i.meta ?? [])
    .map(
      (m) =>
        `<tr><td style="padding:6px 0;color:#5B6470;font-size:14px;width:80px">${esc(m.label)}</td><td style="padding:6px 0;color:#14161A;font-size:15px;font-weight:600">${esc(m.value)}</td></tr>`,
    )
    .join("");
  const btn = (label: string, url: string, primary: boolean) =>
    `<a href="${esc(url)}" style="display:inline-block;padding:14px 22px;border-radius:14px;font-weight:700;font-size:16px;text-decoration:none;${
      primary ? "background:#C8F135;color:#14161A;" : "background:#F1F0EA;color:#14161A;"
    }margin:0 8px 8px 0">${esc(label)}</a>`;
  const html = `<!doctype html><html><body style="margin:0;background:#F4F3EE;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Inter,Arial,sans-serif;color:#14161A">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F3EE;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:20px;padding:28px 24px">
<tr><td style="font-size:13px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#5B6470">🎾 ${esc(APP_NAME)}</td></tr>
<tr><td style="padding-top:14px;font-size:24px;font-weight:800;line-height:1.2">${esc(i.heading)}</td></tr>
<tr><td style="padding-top:12px;font-size:16px;line-height:1.5;color:#2A2F36">${esc(i.body)}</td></tr>
${meta ? `<tr><td style="padding-top:16px"><table role="presentation" cellpadding="0" cellspacing="0">${meta}</table></td></tr>` : ""}
<tr><td style="padding-top:22px">${i.cta ? btn(i.cta.label, i.cta.url, true) : ""}${i.secondary ? btn(i.secondary.label, i.secondary.url, false) : ""}</td></tr>
<tr><td style="padding-top:8px"><a href="${esc(i.eventUrl)}" style="color:#1B4FD8;font-size:14px">${esc(i.openLabel)} →</a></td></tr>
${i.personal ? `<tr><td style="padding-top:18px"><div style="background:#F4F3EE;border-radius:14px;padding:12px 14px;font-size:13px;color:#2A2F36"><strong>${esc(i.personal.label)}</strong><br><a href="${esc(i.personal.url)}" style="color:#1B4FD8;word-break:break-all">${esc(i.personal.url)}</a></div></td></tr>` : ""}
<tr><td style="padding-top:26px;border-top:1px solid #E4E2DA;margin-top:20px;font-size:12px;color:#8A919C;line-height:1.5">${esc(i.footer)}<br><a href="${esc(i.eventUrl)}" style="color:#8A919C">${esc(i.eventUrl)}</a></td></tr>
</table></td></tr></table></body></html>`;
  const text = [
    i.heading,
    "",
    i.body,
    "",
    ...(i.meta ?? []).map((m) => `${m.label}: ${m.value}`),
    "",
    i.cta ? `${i.cta.label}: ${i.cta.url}` : "",
    i.secondary ? `${i.secondary.label}: ${i.secondary.url}` : "",
    `${i.openLabel}: ${i.eventUrl}`,
    i.personal ? `${i.personal.label}: ${i.personal.url}` : "",
    "",
    i.footer,
  ]
    .filter((l) => l !== undefined)
    .join("\n");
  return { html, text };
}
