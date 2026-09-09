import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { getDb } from "@/db";
import { shortHost } from "@/lib/config";
import { getMilestone } from "@/lib/domain/milestones";
import { momentLine, momentWhere } from "@/lib/moments";
import { toLocale } from "@/i18n/config";

export const alt = "Padel moment";
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

const EMOJI: Record<string, string> = { first_win: "🏆", matches_10: "🔟", matches_50: "5️⃣0️⃣", streak_3: "🔥", partners_10: "🤝", level_up: "📈", podium: "🥇" };

/** The moment as a picture: big line, the name, where and when, the frame. Same bones as the result card. */
export default async function MomentImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDb();
  const hit = await getMilestone(db, id);
  const host = shortHost();
  const fontList = await fonts();
  if (!hit) {
    return new ImageResponse(<div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: BG, color: INK, fontSize: 64, fontWeight: 800, fontFamily: "Inter" }}>{host}</div>, { ...size, fonts: fontList });
  }
  const locale = toLocale(hit.player.locale) ?? "en";
  const line = await momentLine(hit.milestone, locale);
  const where = await momentWhere(db, hit.milestone, locale);
  const badge = hit.milestone.kind === "podium" ? (hit.milestone.value.endsWith(":1") ? "🥇" : hit.milestone.value.endsWith(":2") ? "🥈" : "🥉") : (EMOJI[hit.milestone.kind] ?? "🎾");
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: BG, fontFamily: "Inter", color: INK }}>
        <div style={{ width: 28, height: "100%", background: ACCENT, display: "flex" }} />
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "48px 64px 44px 56px", flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 30, height: 30, borderRadius: 10, background: INK, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <div style={{ width: 14, height: 14, borderRadius: 7, background: ACCENT, display: "flex" }} />
            </div>
            <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -0.5 }}>{host}</div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 40 }}>
            <div style={{ fontSize: 150, display: "flex" }}>{badge}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: 2, textTransform: "uppercase", color: MUTED }}>{hit.player.displayName}</div>
              <div style={{ fontSize: 68, fontWeight: 800, letterSpacing: -2, lineHeight: 1.05, maxWidth: 820 }}>{line}</div>
              {where && <div style={{ fontSize: 28, color: MUTED }}>{where}</div>}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", background: INK, color: "#fff", padding: "14px 26px", borderRadius: 999, fontSize: 28, fontWeight: 800 }}>{t(locale)}</div>
            <div style={{ fontSize: 26, color: MUTED }}>{`kicksma.sh`}</div>
          </div>
        </div>
      </div>
    ),
    { ...size, fonts: fontList },
  );
}

const t = (locale: string) => (locale === "ru" ? "Момент" : locale === "es" ? "Momento" : "Moment");
