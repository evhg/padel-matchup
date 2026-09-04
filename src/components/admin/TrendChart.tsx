"use client";

import { useId, useMemo, useState } from "react";

export type Series = { name: string; color: string; values: number[] };

const W = 640;
const H = 220;
const PAD = { top: 16, right: 16, bottom: 28, left: 44 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const m = v / p;
  const step = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return step * p;
}

/**
 * One-axis line/area chart: hairline grid, 2px lines, end markers with a
 * surface ring, crosshair tooltip, legend for 2+ series, and a table view.
 * Colors are passed in (categorical slots); text stays in text tokens.
 */
const FORMATS: Record<string, (v: number) => string> = {
  int: (v) => new Intl.NumberFormat("en").format(Math.round(v)),
  mb: (v) => `${v} MB`,
};

/** `unit` picks the formatter here: functions can't cross the server → client boundary. */
export function TrendChart({ title, days, series, unit = "int", subtitle }: { title: string; days: string[]; series: Series[]; unit?: "int" | "mb"; subtitle?: string }) {
  const id = useId();
  const format = FORMATS[unit] ?? FORMATS.int;
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const n = days.length;
  const max = useMemo(() => niceMax(Math.max(1, ...series.flatMap((s) => s.values))), [series]);
  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i * (W - PAD.left - PAD.right)) / (n - 1));
  const y = (v: number) => PAD.top + (H - PAD.top - PAD.bottom) * (1 - v / max);
  // Integer-friendly ticks: 0..max when small, else five even steps of a "nice" max.
  const ticks = max <= 5 && unit === "int" ? Array.from({ length: max + 1 }, (_, i) => i) : [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => f * max);
  const labelEvery = n > 45 ? 15 : n > 14 ? 7 : 1;
  const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  const path = (vals: number[]) => vals.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / (W - PAD.left - PAD.right)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  return (
    <section className="card">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="font-extrabold">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        <button type="button" className="btn-ghost btn-xs" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Chart" : "Table"}
        </button>
      </div>
      {series.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs font-semibold text-muted">
          {series.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      {table ? (
        <div className="mt-3 max-h-64 overflow-auto">
          <table className="w-full text-xs tabular-nums">
            <thead>
              <tr className="text-left text-faint">
                <th className="py-1 pr-2 font-bold">Day</th>
                {series.map((s) => (
                  <th key={s.name} className="py-1 pr-2 text-right font-bold">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {days.map((d, i) => (
                <tr key={d} className="border-t border-line">
                  <td className="py-1 pr-2">{d}</td>
                  {series.map((s) => (
                    <td key={s.name} className="py-1 pr-2 text-right">
                      {format(s.values[i] ?? 0)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative mt-2">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full touch-none select-none" role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            <defs>
              {series.map((s, si) => (
                <linearGradient key={si} id={`${id}-g${si}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={s.color} stopOpacity="0.16" />
                  <stop offset="1" stopColor={s.color} stopOpacity="0.02" />
                </linearGradient>
              ))}
            </defs>
            {ticks.map((tv) => (
              <g key={tv}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(tv)} y2={y(tv)} stroke="#e4e2da" strokeWidth="1" />
                <text x={PAD.left - 8} y={y(tv) + 3} textAnchor="end" fontSize="10" fill="#8a919c">
                  {format(tv)}
                </text>
              </g>
            ))}
            {days.map((d, i) =>
              (i % labelEvery === 0 && n - 1 - i >= Math.max(2, labelEvery / 2)) || i === n - 1 ? (
                <text key={d} x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"} fontSize="10" fill="#8a919c">
                  {fmtDay(d)}
                </text>
              ) : null,
            )}
            {series.map((s, si) => (
              <g key={s.name}>
                {series.length === 1 && <path d={`${path(s.values)} L${x(n - 1).toFixed(1)},${y(0)} L${x(0).toFixed(1)},${y(0)} Z`} fill={`url(#${id}-g${si})`} />}
                <path d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={x(n - 1)} cy={y(s.values[n - 1] ?? 0)} r="5" fill={s.color} stroke="#ffffff" strokeWidth="2" />
              </g>
            ))}
            {hover !== null && (
              <g>
                <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={H - PAD.bottom} stroke="#8a919c" strokeWidth="1" />
                {series.map((s) => (
                  <circle key={s.name} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r="5" fill={s.color} stroke="#ffffff" strokeWidth="2" />
                ))}
              </g>
            )}
          </svg>
          {hover !== null && (
            <div className="pointer-events-none absolute top-2 rounded-xl border border-line bg-white px-3 py-2 text-xs shadow-card" style={{ left: `${(x(hover) / W) * 100}%`, transform: x(hover) > W / 2 ? "translateX(calc(-100% - 8px))" : "translateX(8px)" }}>
              <div className="font-bold">{fmtDay(days[hover])}</div>
              {series.map((s) => (
                <div key={s.name} className="mt-0.5 flex items-center gap-1.5 tabular-nums">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-muted">{s.name}</span>
                  <span className="ml-auto pl-3 font-bold">{format(s.values[hover] ?? 0)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
