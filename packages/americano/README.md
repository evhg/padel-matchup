# @kicksmash/americano

Americano, mexicano and King of the Court schedules for padel. This is the exact rotation engine behind [kicksma.sh](https://kicksma.sh): pure TypeScript, no dependencies, deterministic for a seed, works in Node and in the browser.

```sh
npm install @kicksmash/americano
```

## A whole schedule in one call

```ts
import { buildSchedule } from "@kicksmash/americano";

const s = buildSchedule({ names: ["Ana", "Bo", "Chen", "Dee", "Eli", "Fay", "Gus", "Hana"] });
// s.exact === true: 8 players in fours, every pair partners exactly once in 7 rounds
for (const round of s.rounds) {
  for (const m of round.matches) console.log(`Round ${round.round} · Court ${m.court}: ${m.a.join(" + ")} vs ${m.b.join(" + ")}`);
  if (round.resting.length) console.log(`  resting: ${round.resting.join(", ")}`);
}
```

Options: `players` (4–64, ignored when `names` are given), `courts` (default `floor(players / 4)`), `rounds` (default `players − 1` when the field is in fours, else `players`, max 40), `seed`. When the field is not in fours or fewer courts are used, sit-outs are spread fairly and pairings minimise repeated partners first, repeated opponents second.

## Round by round, with scores

For live tournaments the engine plans one round at a time from what has been played:

```ts
import { buildHistory, planRound, computeStandings, type RoundRef } from "@kicksmash/americano";

const ids = ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"];
const played: RoundRef[] = []; // fill sideA / sideB as scores come in
const next = planRound(ids, 2, buildHistory(played));
const table = computeStandings(ids, played.flatMap((r) => r.matches));
```

Mexicano (courts formed by the standings, 1st + 4th against 2nd + 3rd) and King of the Court (winners move up a court, losers down, partners split) are `planMexicanoRound`, `planKingRound` and `computeKingStandings`; round one of both is random, later rounds need every score of the previous round.

## The same engine, other doors

- `https://kicksma.sh/api/v1/schedule?players=12&courts=3` returns the same JSON without installing anything; `POST` accepts names.
- The MCP server at `https://kicksma.sh/mcp` exposes it as the `generate_schedule` tool.
- `https://kicksma.sh/americano/12` is the printable page.

Generated from `src/lib/domain` in [evhg/padel-matchup](https://github.com/evhg/padel-matchup); issues and ideas go there. Apache-2.0.
