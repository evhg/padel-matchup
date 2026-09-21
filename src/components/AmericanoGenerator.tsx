"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { buildHistory, maxCourtsFor, mulberry32, planRound, rotationLength, scheduleRound, seededShuffle, type Pairing, type RoundRef } from "@/lib/domain/americano";

type Round = { matches: Pairing[]; resting: string[] };

/** What a link carries. The rounds are a pure function of these five, so nothing is stored. */
export type GenSetup = { n: number; courts: number; rounds: number; seed: number; names: string[] };

/**
 * The rounds for a setup. Deterministic: the same five inputs always give the same draw, which is
 * what makes a link enough and a table unnecessary (rule 12).
 */
function build(setup: { n: number; courts: number; roundCount: number; seed: number }): Round[] {
  const { n, courts, roundCount, seed } = setup;
  const cycle = rotationLength(n);
  const exact = Boolean(cycle) && courts === maxCourtsFor(n);
  const ids = Array.from({ length: n }, (_, i) => `p${i}`);
  const rng = mulberry32(seed * 7919 + n);
  const ordered = seededShuffle(ids, mulberry32(seed * 104729 + n));
  const out: Round[] = [];
  const refs: RoundRef[] = [];
  for (let r = 0; r < roundCount; r++) {
    let plan: Round;
    if (exact && cycle && r >= cycle) plan = out[r - cycle];
    else if (exact) plan = scheduleRound(ordered, r, buildHistory(refs), rng);
    else plan = planRound(ids, courts, buildHistory(refs), rng);
    out.push(plan);
    refs.push({ matches: plan.matches.map((m) => ({ a1: m.a[0], a2: m.a[1], b1: m.b[0], b2: m.b[1], sideA: null, sideB: null })), resting: plan.resting });
  }
  return out;
}

/** Same engine as live tournaments, run in the browser: paste names, get every round, print it, send it or take it live. */
export function AmericanoGenerator({ initial }: { initial?: GenSetup | null }) {
  const t = useTranslations();
  const [count, setCount] = useState(initial?.n ?? 8);
  const [namesText, setNamesText] = useState(initial?.names.join("\n") ?? "");
  const [courtsInput, setCourtsInput] = useState<number | null>(initial?.courts ?? null);
  const [roundsInput, setRoundsInput] = useState<number | null>(initial?.rounds ?? null);
  const [seed, setSeed] = useState(initial?.seed ?? 1);
  // A link opens on the schedule it names. The same pure function runs here and on every tap below,
  // so the first paint and a later shuffle cannot disagree.
  const [rounds, setRounds] = useState<Round[] | null>(initial ? build({ n: initial.n, courts: initial.courts, roundCount: initial.rounds, seed: initial.seed }) : null);
  const [copied, setCopied] = useState(false);

  // Sixty-four is the field the engine and the form both stop at. Without this cap a pasted club
  // list of two hundred names built two hundred players' rounds in the browser and froze the page.
  const names = useMemo(() => namesText.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 64), [namesText]);
  const n = names.length >= 4 ? names.length : Math.min(64, Math.max(4, Math.round(count) || 4));
  const maxCourts = maxCourtsFor(n);
  const courts = Math.min(maxCourts, Math.max(1, courtsInput ?? maxCourts));
  const cycle = rotationLength(n);
  const exact = Boolean(cycle) && courts === maxCourts;
  const roundCount = Math.min(40, Math.max(1, roundsInput ?? (exact ? (cycle as number) : n)));
  const playerName = (i: number) => names[i] ?? `${t("americano.gen.players").replace(/s$/, "")} ${i + 1}`;
  const label = (id: string) => playerName(Number(id.slice(1)));

  /** The address of this exact draw. It went in the address bar, so closing the tab stops losing the work. */
  const linkFor = (s: number) => {
    const q = new URLSearchParams({ n: String(n), courts: String(courts), rounds: String(roundCount), seed: String(s) });
    if (names.length >= 4) q.set("names", names.join(","));
    return `/americano?${q.toString()}`;
  };

  const generate = (s = seed) => {
    setRounds(build({ n, courts, roundCount, seed: s }));
    setCopied(false);
    // replaceState, not push: the back button belongs to the page they arrived from, not to a shuffle.
    if (typeof window !== "undefined") window.history.replaceState(null, "", linkFor(s));
  };

  const copy = async () => {
    if (typeof window === "undefined") return;
    const url = new URL(linkFor(seed), window.location.origin).toString();
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      // No clipboard permission (an insecure origin, an old browser): the address bar already holds
      // the same link, so say nothing false and leave the button as it was.
      setCopied(false);
    }
  };

  const capacity = Math.min(64, Math.max(4, Math.ceil(n / 4) * 4));

  return (
    <>
      <section className="card no-print flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-3">
          <label className="block">
            <span className="label">{t("americano.gen.players")}</span>
            <input className="input" type="number" min={4} max={64} value={names.length >= 4 ? names.length : count} disabled={names.length >= 4} onChange={(e) => setCount(Number(e.target.value))} />
          </label>
          <label className="block">
            <span className="label">{t("americano.gen.courts")}</span>
            <select className="input px-3" value={courts} onChange={(e) => setCourtsInput(Number(e.target.value))}>
              {Array.from({ length: maxCourts }, (_, i) => i + 1).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="label">{t("americano.gen.rounds")}</span>
            <input className="input" type="number" min={1} max={40} value={roundCount} onChange={(e) => setRoundsInput(Number(e.target.value))} />
          </label>
        </div>
        <label className="block">
          <span className="label">{t("americano.gen.names")}</span>
          <textarea className="textarea min-h-24" value={namesText} placeholder={t("americano.gen.namesPlaceholder")} onChange={(e) => setNamesText(e.target.value)} />
        </label>
        <p className="text-sm text-muted">{exact ? t("americano.gen.perfect", { n: cycle as number }) : t("americano.gen.partial", { players: n, courts, resting: n - courts * 4 })}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary flex-1" onClick={() => generate()}>
            {t("americano.gen.generate")}
          </button>
          {rounds && (
            <>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  const s = seed + 1;
                  setSeed(s);
                  generate(s);
                }}
              >
                {t("americano.gen.shuffle")}
              </button>
              <button type="button" className="btn-ghost" onClick={() => window.print()}>
                🖨 {t("americano.gen.print")}
              </button>
            </>
          )}
        </div>
      </section>

      {rounds && (
        <>
          {/* The schedule had no address of its own: an organiser could print it or start again, and
              closing the tab lost the work. The draw is a pure function of five numbers and the
              names, so the link carries all of them and no row is stored. */}
          <section className="card no-print" data-testid="gen-share">
            <button type="button" className="btn-secondary w-full" onClick={copy} data-testid="gen-copy">
              {copied ? `✓ ${t("americano.gen.copied")}` : t("americano.gen.copy")}
            </button>
            <p className="mt-2 text-xs text-muted">{t("americano.gen.shareHelp")}</p>
          </section>
          <section className="flex flex-col gap-3">
            {rounds.map((r, i) => (
              <div key={i} className="card py-4">
                <div className="font-extrabold">{t("americano.round", { n: i + 1 })}</div>
                <ul className="mt-2 flex flex-col gap-1.5 text-sm">
                  {r.matches.map((m) => (
                    <li key={m.court} className="flex flex-wrap items-baseline gap-x-2">
                      <span className="w-16 shrink-0 text-xs font-bold uppercase tracking-wider text-faint">{t("americano.court", { n: m.court })}</span>
                      <span className="font-semibold">
                        {label(m.a[0])} &amp; {label(m.a[1])}
                      </span>
                      <span className="text-faint">vs</span>
                      <span className="font-semibold">
                        {label(m.b[0])} &amp; {label(m.b[1])}
                      </span>
                    </li>
                  ))}
                </ul>
                {r.resting.length > 0 && <p className="mt-2 text-xs text-muted">{t("americano.resting", { names: r.resting.map(label).join(", ") })}</p>}
              </div>
            ))}
          </section>
          <section className="card no-print bg-accent-soft border-accent">
            <div className="font-extrabold">{t("americano.gen.live")}</div>
            <p className="mt-1 text-sm text-muted">{t("americano.gen.liveHelp")}</p>
            {/* The names go with it, so eight people are typed once and not twice; s=gen is how the
                tap is counted, which nothing did before. */}
            <Link href={`/?type=tournament&capacity=${capacity}&s=gen${names.length >= 4 ? `&names=${encodeURIComponent(names.join(","))}` : ""}`} prefetch={false} className="btn-primary mt-3 w-full" data-testid="gen-live">
              {t("americano.gen.live")} →
            </Link>
          </section>
        </>
      )}
    </>
  );
}
