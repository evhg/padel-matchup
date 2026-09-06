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

## Other apps' scales and the passport

```ts
import { fromScale, LEVEL_SCALES, verifyPassport } from "@kicksmash/levels";

fromScale("ten", 7); // 4.75: a 1–10 club scale mapped onto 0–7 in the open
fromScale("five", 3); // 3.25
fromScale("playtomic", 3.5); // 3.5: Playtomic already uses the same numbers

// A player's signed level from kicksma.sh, checked without asking anyone
const doc = await fetch("https://kicksma.sh/u/ana-x7k2m/passport.json").then((r) => r.json());
const { keys } = await fetch("https://kicksma.sh/.well-known/kicksmash-passport.json").then((r) => r.json());
const ok = await verifyPassport(doc, keys.find((k) => k.kid === doc.kid).hex); // Ed25519 over canonical JSON, WebCrypto
```

What the numbers mean, and how they move after a match or a tournament, is written up at [kicksma.sh/levels](https://kicksma.sh/levels). Levels imported from other apps map onto the same 0–7 scale.

Generated from `src/lib/domain/levels.ts` in [evhg/padel-matchup](https://github.com/evhg/padel-matchup); issues and ideas go there. Apache-2.0.
