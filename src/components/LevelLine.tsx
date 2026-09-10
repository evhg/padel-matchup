import { formatLevel } from "@/lib/domain/levels";
import { lineGeometry, type LevelSeries } from "@/lib/domain/levelSeries";

/** The level as a line, not a number: results move it, a tick marks the confirmation, today closes it. Server-rendered SVG, theme colours from the text. */
export function LevelLine({ series, caption, ariaLabel }: { series: LevelSeries; caption: string; ariaLabel: string }) {
  const g = lineGeometry(series);
  const first = series.points[0];
  const last = series.points[series.points.length - 1];
  return (
    <figure className="mt-3" data-testid="level-line">
      <svg viewBox={`0 0 ${g.width} ${g.height}`} className="h-auto w-full text-ink" role="img" aria-label={ariaLabel}>
        {g.yTicks.map((tk) => (
          <g key={tk.label}>
            <line x1={0} x2={g.width} y1={tk.y} y2={tk.y} stroke="currentColor" strokeOpacity={0.12} strokeDasharray="2 4" />
            <text x={g.width} y={tk.y - 3} textAnchor="end" fontSize="9" fontWeight="700" fill="currentColor" fillOpacity={0.5}>
              {formatLevel(tk.label)}
            </text>
          </g>
        ))}
        <path d={g.path} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {g.points.map((p, i) => (
          <g key={i}>
            <circle cx={p.x} cy={p.y} r={p.kind === "confirmed" || p.kind === "now" ? 4 : 2.5} fill="currentColor" fillOpacity={p.kind === "adjusted" ? 0.35 : 1} />
            {p.kind === "confirmed" && (
              <text x={p.x} y={p.y - 7} textAnchor="middle" fontSize="10" fontWeight="800" fill="currentColor">
                ✓
              </text>
            )}
          </g>
        ))}
      </svg>
      <figcaption className="mt-1 flex items-center justify-between gap-2 text-[11px] font-semibold text-faint">
        <span>
          {formatLevel(first.level)} → {formatLevel(last.level)}
        </span>
        <span>{caption}</span>
      </figcaption>
    </figure>
  );
}
