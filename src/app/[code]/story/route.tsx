import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { createTranslator } from "next-intl";
import { getDb } from "@/db";
import { loadMessages, toLocale } from "@/i18n/config";
import { calendarTitle } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { shortHost } from "@/lib/config";
import { formatEventDay, formatEventTime } from "@/lib/dates";
import { isClaimable, isOccupied } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { venueWithCourt } from "@/lib/labels";

export const dynamic = "force-dynamic";

const W = 1080;
const H = 1920;
const INK = "#14161A";
const MUTED = "#5B6470";
const BG = "#F4F3EE";
const ACCENT = "#C8F135";
const RED = "#D93838";

async function fonts() {
  const dir = join(process.cwd(), "src/lib/og/fonts");
  const [regular, bold] = await Promise.all([readFile(join(dir, "Inter-Regular.ttf")), readFile(join(dir, "Inter-ExtraBold.ttf"))]);
  return [
    { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: bold, weight: 800 as const, style: "normal" as const },
  ];
}

/**
 * The 9:16 picture a coach posts as an Instagram story: time, day, court, who is
 * in, how many spots are left, and the short link to put in the link sticker.
 * Rendered in the organiser's language, like every other shared picture.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const db = await getDb();
  const detail = isValidShareCode(code) ? await getEventByCode(db, code) : null;
  const host = shortHost();
  const fontList = await fonts();
  if (!detail) {
    return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: BG, color: INK, fontSize: 72, fontWeight: 800, fontFamily: "Inter" }}>{host}</div>, { width: W, height: H, fonts: fontList, status: 404 });
  }
  const { event: ev, roster } = detail;
  const locale = toLocale(detail.creator.locale) ?? "en";
  const t = createTranslator({ locale, messages: await loadMessages(locale) });
  const occupied = roster.filter(isOccupied).length;
  const spotsLeft = roster.filter(isClaimable).length;
  const cancelled = ev.status === "cancelled";
  const finished = ev.status === "past";
  const title = calendarTitle(ev, t(ev.type === "match" ? "og.match" : "og.tournament"));
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const time = formatEventTime(ev.startsAt, ev.tz, locale);
  const venue = venueWithCourt(ev, { venueTbd: t("og.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) });
  const players = t("og.players", { count: occupied, capacity: ev.capacity });
  const pill = cancelled ? t("og.cancelled") : finished ? t("og.finished") : spotsLeft > 0 ? `${players} · ${t("og.tapToJoin")}` : ev.whenFull === "waitlist" ? `${players} · ${t("og.waitlist")}` : `${players} · ${t("og.full")}`;
  const names = roster.filter(isOccupied).map((s) => s.player?.displayName ?? s.invitedName ?? "?").slice(0, 8);
  const empty = Math.max(0, Math.min(ev.capacity, 8) - names.length);

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", background: BG, fontFamily: "Inter", color: INK, padding: "88px 72px 96px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div style={{ width: 64, height: 64, borderRadius: 20, background: INK, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 30, height: 30, borderRadius: 30, background: ACCENT }} />
          </div>
          <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: -1 }}>{host}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 18, marginTop: 120 }}>
          <div style={{ fontSize: 44, fontWeight: 800, color: MUTED, letterSpacing: -1, textDecoration: cancelled ? "line-through" : "none", overflow: "hidden", whiteSpace: "nowrap" }}>{title}</div>
          <div style={{ fontSize: 220, fontWeight: 800, letterSpacing: -12, lineHeight: 0.95 }}>{time}</div>
          <div style={{ fontSize: 64, fontWeight: 800, letterSpacing: -2 }}>{day}</div>
          <div style={{ fontSize: 44, color: MUTED, overflow: "hidden", whiteSpace: "nowrap" }}>{venue}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 22, marginTop: 100 }}>
          <div style={{ display: "flex", alignSelf: "flex-start", background: cancelled ? "#FDECEC" : finished ? "#E4E2DA" : spotsLeft > 0 ? ACCENT : "#FEF3C7", color: cancelled ? RED : INK, padding: "20px 34px", borderRadius: 999, fontSize: 40, fontWeight: 800 }}>{pill}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
            {names.map((n, i) => (
              <div key={i} style={{ display: "flex", background: INK, color: "#fff", padding: "16px 26px", borderRadius: 999, fontSize: 36, fontWeight: 800, maxWidth: 460, overflow: "hidden", whiteSpace: "nowrap" }}>
                {n}
              </div>
            ))}
            {Array.from({ length: empty }, (_, i) => (
              <div key={`e${i}`} style={{ display: "flex", width: 72, height: 72, borderRadius: 72, border: `5px dashed ${cancelled ? RED : INK}` }} />
            ))}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: "auto" }}>
          <div style={{ width: 120, height: 14, background: cancelled ? RED : ACCENT, borderRadius: 14 }} />
          <div style={{ fontSize: 84, fontWeight: 800, letterSpacing: -3 }}>{`${host}/${ev.code}`}</div>
          <div style={{ fontSize: 36, color: MUTED }}>{t("card.poweredBy")}</div>
        </div>
      </div>
    ),
    { width: W, height: H, fonts: fontList, headers: { "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300" } },
  );
}
