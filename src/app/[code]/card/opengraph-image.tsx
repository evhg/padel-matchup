import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { createTranslator } from "next-intl";
import { getDb } from "@/db";
import { loadMessages, toLocale } from "@/i18n/config";
import { calendarTitle } from "@/lib/calendar";
import { isValidShareCode } from "@/lib/codes";
import { shortHost } from "@/lib/config";
import { formatEventDay } from "@/lib/dates";
import { isOccupied } from "@/lib/domain/events";
import { getEventByCode } from "@/lib/domain/queries";
import { matchResult } from "@/lib/domain/result";
import { getTournamentState } from "@/lib/domain/tournament";
import { venueWithCourt } from "@/lib/labels";

export const alt = "Padel result";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#14161A";
const MUTED = "#5B6470";
const BG = "#F4F3EE";
const ACCENT = "#C8F135";

async function fonts() {
  const dir = join(process.cwd(), "src/lib/og/fonts");
  const [regular, bold] = await Promise.all([readFile(join(dir, "Inter-Regular.ttf")), readFile(join(dir, "Inter-ExtraBold.ttf"))]);
  return [
    { name: "Inter", data: regular, weight: 400 as const, style: "normal" as const },
    { name: "Inter", data: bold, weight: 800 as const, style: "normal" as const },
  ];
}

/** Shareable result picture: the score for a match, the top of the table for a tournament. */
export default async function CardImage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const db = await getDb();
  const detail = isValidShareCode(code) ? await getEventByCode(db, code) : null;
  const host = shortHost();
  const fontList = await fonts();
  if (!detail) {
    return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: BG, color: INK, fontSize: 64, fontWeight: 800, fontFamily: "Inter" }}>{host}</div>, { ...size, fonts: fontList });
  }
  const { event: ev, roster } = detail;
  const locale = toLocale(detail.creator.locale) ?? "en";
  const t = createTranslator({ locale, messages: await loadMessages(locale) });
  const title = calendarTitle(ev, t(ev.type === "match" ? "og.match" : "og.tournament"));
  const day = formatEventDay(ev.startsAt, ev.tz, locale);
  const venue = venueWithCourt(ev, { venueTbd: t("og.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) });
  const nameOf = (s: (typeof roster)[number]) => s.player?.displayName ?? s.invitedName ?? "?";

  let body: React.ReactNode;
  if (ev.type === "match") {
    const r = matchResult(detail.scores, roster.map((s) => ({ team: s.team, status: s.status, name: nameOf(s) })));
    const rowA = r?.hasTeams ? r.a.join(" & ") : t("card.teamA");
    const rowB = r?.hasTeams ? r.b.join(" & ") : t("card.teamB");
    const row = (label: string, side: "a" | "b") => (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 24 }}>
        <div style={{ fontSize: 46, fontWeight: 800, letterSpacing: -1, color: r && r.winner !== side && r.winner !== "draw" ? MUTED : INK, maxWidth: 720, overflow: "hidden", whiteSpace: "nowrap" }}>{label}</div>
        <div style={{ display: "flex", gap: 14 }}>
          {(r?.sets ?? []).map((s, i) => {
            const mine = side === "a" ? s.sideA : s.sideB;
            const theirs = side === "a" ? s.sideB : s.sideA;
            return (
              <div key={i} style={{ width: 96, height: 96, borderRadius: 24, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 56, fontWeight: 800, background: mine > theirs ? ACCENT : "#E4E2DA", color: mine > theirs ? INK : MUTED }}>
                {mine}
              </div>
            );
          })}
        </div>
      </div>
    );
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {row(rowA, "a")}
        {row(rowB, "b")}
      </div>
    );
  } else {
    const named = roster.filter((s) => isOccupied(s) || s.status === "invited");
    const ids = named.map((s) => s.playerId).filter((x): x is string => Boolean(x));
    const state = await getTournamentState(db, ev, ids);
    const names = new Map(named.filter((s) => s.playerId).map((s) => [s.playerId!, nameOf(s)]));
    const top = state.standings.slice(0, 5);
    body = (
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", color: MUTED }}>{ev.scoreLockedByCreator ? t("card.standingsFinal") : t("card.standingsLive")}</div>
        {top.map((s) => (
          <div key={s.playerId} style={{ display: "flex", alignItems: "center", gap: 20, background: s.rank === 1 ? ACCENT : "transparent", borderRadius: 18, padding: "6px 16px" }}>
            <div style={{ width: 56, fontSize: 40, fontWeight: 800 }}>{s.rank}</div>
            <div style={{ flex: 1, fontSize: 40, fontWeight: 800, letterSpacing: -1, overflow: "hidden", whiteSpace: "nowrap" }}>{names.get(s.playerId) ?? "?"}</div>
            <div style={{ fontSize: 36, fontWeight: 800, color: s.rank === 1 ? INK : MUTED }}>{t("card.pts", { points: s.points })}</div>
          </div>
        ))}
      </div>
    );
  }

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: BG, fontFamily: "Inter", color: INK }}>
        <div style={{ width: 28, height: "100%", background: ACCENT, display: "flex" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "48px 64px 44px 56px", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 44, height: 44, borderRadius: 14, background: INK, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <div style={{ width: 22, height: 22, borderRadius: 22, background: ACCENT }} />
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>{host}</div>
            </div>
            <div style={{ fontSize: 26, color: MUTED, maxWidth: 700, overflow: "hidden", whiteSpace: "nowrap" }}>{`${title} · ${day} · ${venue}`}</div>
          </div>
          {body}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", background: INK, color: "#fff", padding: "14px 26px", borderRadius: 999, fontSize: 28, fontWeight: 800 }}>{t("card.result")}</div>
            <div style={{ fontSize: 26, color: MUTED }}>{`${t("card.poweredBy")} · ${host}`}</div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: fontList, headers: { "Cache-Control": "public, max-age=0, s-maxage=120, stale-while-revalidate=600" } },
  );
}
