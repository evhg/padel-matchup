/**
 * Busy time from a secret iCal address (Apple, Outlook, or Google without sharing).
 * Read-only: enough to keep the coach's free slots honest. Simple weekly repeats are
 * expanded inside the window; anything more exotic counts once, at its first date.
 */

export type IcsBusy = { uid: string; start: Date; end: Date; summary: string };

const unfold = (text: string) => text.replace(/\r?\n[ \t]/g, "");

function parseDate(value: string, params: string): Date | null {
  const tzid = /TZID=([^;:]+)/.exec(params)?.[1];
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh = "00", mm = "00", ss = "00", z] = m;
  if (z || !tzid || !m[4]) return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss)));
  // Wall clock in a named zone: find the UTC instant whose wall clock in that zone matches.
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mm), Number(ss));
  try {
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tzid, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const at = (t: number) => {
      const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
      return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    };
    let guess = naive - (at(naive) - naive);
    guess -= at(guess) - naive;
    return new Date(guess);
  } catch {
    return new Date(naive);
  }
}

const DOW: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

/** VEVENTs overlapping [from, to) as busy spans. */
export function parseIcsBusy(text: string, from: Date, to: Date): IcsBusy[] {
  const out: IcsBusy[] = [];
  const body = unfold(text);
  const events = body.split(/BEGIN:VEVENT/).slice(1);
  for (const raw of events) {
    const block = raw.split(/END:VEVENT/)[0];
    const prop = (name: string) => {
      const m = new RegExp(`^${name}([^:\\n]*):(.*)$`, "m").exec(block);
      return m ? { params: m[1], value: m[2].trim() } : null;
    };
    const status = prop("STATUS")?.value.toUpperCase();
    if (status === "CANCELLED") continue;
    if (prop("TRANSP")?.value.toUpperCase() === "TRANSPARENT") continue;
    const dtstart = prop("DTSTART");
    if (!dtstart) continue;
    const start = parseDate(dtstart.value, dtstart.params);
    if (!start) continue;
    const dtend = prop("DTEND");
    let end = dtend ? parseDate(dtend.value, dtend.params) : null;
    if (!end) {
      const dur = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(prop("DURATION")?.value ?? "");
      const ms = dur ? (Number(dur[1] ?? 0) * 60 + Number(dur[2] ?? 0)) * 60_000 : dtstart.params.includes("VALUE=DATE") ? 86_400_000 : 3_600_000;
      end = new Date(start.getTime() + ms);
    }
    const uid = prop("UID")?.value ?? `${start.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
    const summary = prop("SUMMARY")?.value ?? "";
    const rrule = prop("RRULE")?.value ?? "";
    const spanMs = end.getTime() - start.getTime();
    const push = (s: Date) => {
      const e = new Date(s.getTime() + spanMs);
      if (e > from && s < to) out.push({ uid: `${uid}@${s.toISOString()}`, start: s, end: e, summary });
    };
    const weekly = /FREQ=WEEKLY/.test(rrule);
    if (!weekly) {
      push(start);
      continue;
    }
    const until = /UNTIL=([0-9TZ]+)/.exec(rrule)?.[1];
    const untilAt = until ? parseDate(until, "") : null;
    const count = Number(/COUNT=(\d+)/.exec(rrule)?.[1] ?? 0);
    const interval = Number(/INTERVAL=(\d+)/.exec(rrule)?.[1] ?? 1);
    const days = (/BYDAY=([A-Z,]+)/.exec(rrule)?.[1] ?? "").split(",").filter(Boolean).map((d) => DOW[d]).filter((d) => d !== undefined);
    const dows = days.length ? days : [start.getUTCDay()];
    let produced = 0;
    for (let week = 0; week < 60 && produced < (count || 1000); week += interval) {
      const weekStart = new Date(start.getTime() + week * 7 * 86_400_000);
      for (const dow of dows) {
        const delta = (dow - weekStart.getUTCDay() + 7) % 7;
        const s = new Date(weekStart.getTime() + delta * 86_400_000);
        if (s < start) continue;
        if (untilAt && s > untilAt) continue;
        if (count && produced >= count) break;
        produced++;
        if (s >= to) continue;
        push(s);
      }
      if (weekStart > to) break;
    }
  }
  return out;
}
