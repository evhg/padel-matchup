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

export const alt = "Padel match";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

async function fonts() {
  const dir = join(process.cwd(), "src/lib/og/fonts");
  const [regular, bold] = await Promise.all([readFile(join(dir, "Inter-Regular.ttf")), readFile(join(dir, "Inter-ExtraBold.ttf"))]);
  return [
    { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: bold, weight: 800 as const, style: "normal" as const },
  ];
}

export default async function OgImage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const db = await getDb();
  const detail = isValidShareCode(code) ? await getEventByCode(db, code) : null;
  const host = shortHost();

  if (!detail) {
    return new ImageResponse(
      (
        <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#F4F3EE", color: "#14161A", fontSize: 64, fontWeight: 800, fontFamily: "Inter" }}>
          {host}
        </div>
      ),
      { ...size, fonts: await fonts() },
    );
  }

  const { event: ev, roster } = detail;
  // Link previews are rendered once for everyone → use the organizer's language.
  const locale = toLocale(detail.creator.locale) ?? "en";
  const t = createTranslator({ locale, messages: await loadMessages(locale) });
  const occupied = roster.filter(isOccupied).length;
  const spotsLeft = roster.filter(isClaimable).length;
  const reserved = roster.filter((s) => s.status === "invited").length;
  const title = calendarTitle(ev, t(ev.type === "match" ? "og.match" : "og.tournament"));
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const time = formatEventTime(ev.startsAt, ev.tz, locale);
  const players = t("og.players", { count: occupied, capacity: ev.capacity });
  const cancelled = ev.status === "cancelled";
  const finished = ev.status === "past";
  const pill = cancelled ? t("og.cancelled") : finished ? t("og.finished") : spotsLeft > 0 ? `${players} — ${t("og.tapToJoin")}` : ev.whenFull === "waitlist" ? `${players} — ${t("og.waitlist")}` : `${players} — ${t("og.full")}`;
  const pillBg = cancelled ? "#FDECEC" : finished ? "#E4E2DA" : spotsLeft > 0 ? "#C8F135" : "#FEF3C7";
  const pillFg = cancelled ? "#D93838" : "#14161A";

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#F4F3EE", fontFamily: "Inter", color: "#14161A" }}>
        <div style={{ width: 28, height: "100%", background: cancelled ? "#D93838" : "#C8F135", display: "flex" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "56px 64px 48px 56px", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div style={{ width: 44, height: 44, borderRadius: 14, background: "#14161A", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 22, height: 22, borderRadius: 22, background: "#C8F135" }} />
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>{host}</div>
            <div style={{ fontSize: 24, color: "#5B6470", marginLeft: 8 }}>{`/${ev.code}`}</div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ fontSize: 40, fontWeight: 800, letterSpacing: -1, lineHeight: 1.1, maxWidth: 1000, overflow: "hidden", textDecoration: cancelled ? "line-through" : "none" }}>{title}</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 24 }}>
              <div style={{ fontSize: 132, fontWeight: 800, letterSpacing: -6, lineHeight: 1 }}>{time}</div>
              <div style={{ display: "flex", flexDirection: "column", paddingBottom: 14 }}>
                <div style={{ fontSize: 44, fontWeight: 800, letterSpacing: -1 }}>{day}</div>
                <div style={{ fontSize: 34, color: "#5B6470", maxWidth: 640, overflow: "hidden", whiteSpace: "nowrap" }}>{venueWithCourt(ev, { venueTbd: t("og.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) })}</div>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", background: pillBg, color: pillFg, padding: "18px 30px", borderRadius: 999, fontSize: 34, fontWeight: 800 }}>{pill}</div>
            <div style={{ display: "flex", gap: 10 }}>
              {Array.from({ length: Math.min(ev.capacity, 8) }, (_, i) => {
                const filled = i < occupied;
                const held = !filled && i < occupied + reserved;
                return (
                  <div
                    key={i}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 34,
                      background: filled ? "#14161A" : held ? "#FEF3C7" : "transparent",
                      border: held ? "4px dashed #B45309" : "4px solid #14161A",
                      display: "flex",
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: await fonts(), headers: { "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=600" } },
  );
}
