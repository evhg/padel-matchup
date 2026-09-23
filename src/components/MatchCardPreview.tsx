"use client";

import { useLocale, useTranslations } from "next-intl";
import { MATCH_CAPACITY } from "@/lib/config";
import { formatEventDay, formatEventTime, isValidTimeZone, zonedTimeToUtc } from "@/lib/dates";
import { venueWithCourt } from "@/lib/labels";

/**
 * The card the match will have, filling in as it is typed.
 *
 * Erik, 20 September: "on the first page, please show the match result card ... the informations of
 * the match such as time, venue is shown on the card as they are being typed in." The card is what
 * the crew actually sees in WhatsApp, and it was the one thing the first page never showed.
 *
 * This is the same drawing as `src/app/[code]/opengraph-image.tsx`, in HTML rather than a PNG, and
 * the same words: the huge time, the day and the venue under it, the pill and the seats. It stays in
 * step because it reads the same helpers — `venueWithCourt`, `formatEventTime` — rather than its own
 * copy of them, and every size is a share of the card's width, so it is the same card at any size.
 *
 * Behind it, when the viewer has one, is the court photo of their last match: the rest of Erik's
 * note ("with my previous match photo as a placeholder"). It needed a public URL per match's photo,
 * which was the owner's call; the owner said yes on 23 September 2026. The photo is no more public
 * than it was: the result card anybody with the link can open already carries it. On a photo the
 * card turns to light words on a dark layer, as the result card does.
 */

/** The card is drawn for 1200px wide; every size here is that measurement as a share of the width. */
const share = (px: number) => `${((px / 1200) * 100).toFixed(3)}cqw`;

export function MatchCardPreview({
  values,
  host,
  photo,
}: {
  values: { type: "match" | "tournament"; title: string; date: string; time: string; tz: string; venueName: string; court: string; capacity: number; haveNames: string };
  host: string;
  /** The URL of the viewer's last match photo (`/{code}/photo`), or nothing. */
  photo?: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const tz = isValidTimeZone(values.tz) ? values.tz : "UTC";
  const when = values.date && values.time ? zonedTimeToUtc(values.date, values.time, tz) : null;
  const title = values.title.trim() || t(values.type === "match" ? "og.match" : "og.tournament");
  const venue = venueWithCourt(
    { venueName: values.venueName.trim() || null, court: values.court.trim() || null },
    { venueTbd: t("og.venueTbd"), courtNumber: (n) => t("event.courtNumber", { n }) },
  );
  // A match holds four, whatever the tournament field says: the form sends a capacity only for a
  // tournament, and the card read "1/8 players" under a match that holds four until a screenshot
  // showed it. The seats follow the same number.
  const capacity = values.type === "match" ? MATCH_CAPACITY : values.capacity;
  // The organiser holds a seat, and so does everybody they have already named.
  const taken = Math.min(capacity, 1 + values.haveNames.split("\n").filter((n) => n.trim()).length);
  const left = Math.max(0, capacity - taken);
  const players = t("og.players", { count: taken, capacity });
  const ink = photo ? "#FFFFFF" : "#14161A";
  const soft = photo ? "rgba(255,255,255,0.82)" : "#5B6470";
  const ground = photo ? `linear-gradient(rgba(20,22,26,0.55), rgba(20,22,26,0.72)), center / cover no-repeat url("${photo}")` : "#F4F3EE";

  return (
    <div
      aria-hidden
      data-testid="card-preview"
      data-photo={photo ? "yes" : "no"}
      style={{ containerType: "inline-size", aspectRatio: "1200 / 630", width: "100%", display: "flex", borderRadius: share(24), overflow: "hidden", background: ground, color: ink }}
    >
      <div style={{ width: share(28), background: "#C8F135" }} />
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", padding: `${share(56)} ${share(64)} ${share(48)} ${share(56)}`, flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: share(16) }}>
          <div style={{ width: share(44), height: share(44), borderRadius: share(14), background: "#14161A", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: share(22), height: share(22), borderRadius: "50%", background: "#C8F135" }} />
          </div>
          <div style={{ fontSize: share(28), fontWeight: 800, letterSpacing: share(-0.5) }}>{host}</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: share(10), minWidth: 0 }}>
          <div style={{ fontSize: share(40), fontWeight: 800, letterSpacing: share(-1), lineHeight: 1.1, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{title}</div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: share(24), minWidth: 0 }}>
            <div style={{ fontSize: share(132), fontWeight: 800, letterSpacing: share(-6), lineHeight: 1, fontVariantNumeric: "tabular-nums" }}>
              {when ? formatEventTime(when, tz, locale) : "--:--"}
            </div>
            <div style={{ display: "flex", flexDirection: "column", paddingBottom: share(14), minWidth: 0 }}>
              <div style={{ fontSize: share(44), fontWeight: 800, letterSpacing: share(-1), whiteSpace: "nowrap" }}>{when ? formatEventDay(when, tz, locale) : ""}</div>
              <div style={{ fontSize: share(34), color: soft, overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>{venue}</div>
            </div>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: share(16) }}>
          <div style={{ background: "#C8F135", color: "#14161A", padding: `${share(18)} ${share(30)}`, borderRadius: 999, fontSize: share(34), fontWeight: 800, whiteSpace: "nowrap" }}>
            {left > 0 ? `${players} — ${t("og.tapToJoin")}` : players}
          </div>
          <div style={{ display: "flex", gap: share(10) }}>
            {Array.from({ length: Math.min(capacity, 8) }, (_, i) => (
              <div key={i} style={{ width: share(34), height: share(34), borderRadius: "50%", background: i < taken ? ink : "transparent", border: `${share(4)} solid ${ink}` }} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
