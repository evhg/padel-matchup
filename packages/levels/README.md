# @kicksmash/levels

Padel levels 0–7 the way [kicksma.sh](https://kicksma.sh) uses them: the bands, the sign-up presets, level ranges for a match, balanced 2v2 teams from four rated players, and the small result-based nudges. Pure TypeScript, no dependencies.

```sh
npm install @kicksmash/levels
```

```ts
import { bandOf, formatLevel, levelFit, rangeFor, balancedTeams, matchDeltas } from "@kicksmash/levels";

bandOf(3.5); // "intermediate"
formatLevel(3.25); // "3.25"

const gold = rangeFor("gold"); // { min: 3, max: 4.5 }
levelFit(gold, 2.5); // "below": this player would ask to join instead of joining

balancedTeams([
  { id: "a", level: 4 },
  { id: "b", level: 2.5 },
  { id: "c", level: 3.5 },
  { id: "d", level: 3 },
]); // { a: [...], b: [...], diff: 0 }: the fairest split of the four

matchDeltas([{ id: "a", level: 3 }, { id: "b", level: 3 }], [{ id: "c", level: 3.5 }, { id: "d", level: 3.5 }], "a");
// Map of id → change after the lower-rated pair won; capped, unrated players never move
```

What the numbers mean, and how they move after a match or a tournament, is written up at [kicksma.sh/levels](https://kicksma.sh/levels). Levels imported from other apps map onto the same 0–7 scale.

Generated from `src/lib/domain/levels.ts` in [evhg/padel-matchup](https://github.com/evhg/padel-matchup); issues and ideas go there. Apache-2.0.
