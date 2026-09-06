// Builds the npm packages from the app's pure domain modules, so there is one
// source of truth: src/lib/domain. Each package gets a generated src/ (copied,
// with imports rewritten for ESM) and a dist/ from tsc. Both are gitignored.
//   pnpm packages:build            build both
//   cd packages/americano && npm publish   (the version lives in each package.json)
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const domain = path.join(root, "src/lib/domain");

const HEADER = `// Generated from src/lib/domain in https://github.com/evhg/padel-matchup by scripts/build-packages.mjs. Do not edit here.\n`;

const PACKAGES = {
  americano: {
    files: ["americano.ts", "formats.ts", "errors.ts", "schedule.ts"],
    extra: { "types.ts": `/** Tournament formats the engine knows. */\nexport type TournamentFormat = "americano" | "mexicano" | "king";\n` },
    index: `export * from "./americano.js";\nexport * from "./formats.js";\nexport * from "./schedule.js";\nexport { DomainError, isDomainError, type DomainErrorCode } from "./errors.js";\nexport type { TournamentFormat } from "./types.js";\n`,
  },
  levels: {
    files: ["levels.ts", "passport.ts"],
    extra: {},
    index: `export * from "./levels.js";\nexport * from "./passport.js";\n`,
  },
};

/** App-only imports become local ones; relative imports get the .js extension Node's ESM loader needs. */
function rewrite(file, src) {
  const out = src.replace(/import type \{ TournamentFormat \} from "@\/db\/schema";/, 'import type { TournamentFormat } from "./types.js";').replace(/from "\.\/([a-zA-Z]+)";/g, 'from "./$1.js";');
  if (/from "@\//.test(out)) throw new Error(`${file} still imports app code; keep the domain modules pure.`);
  return HEADER + out;
}

const only = process.argv[2];
for (const [name, spec] of Object.entries(PACKAGES)) {
  if (only && only !== name) continue;
  const dir = path.join(root, "packages", name);
  const srcDir = path.join(dir, "src");
  rmSync(srcDir, { recursive: true, force: true });
  rmSync(path.join(dir, "dist"), { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  for (const f of spec.files) writeFileSync(path.join(srcDir, f), rewrite(f, readFileSync(path.join(domain, f), "utf8")));
  for (const [f, s] of Object.entries(spec.extra)) writeFileSync(path.join(srcDir, f), HEADER + s);
  writeFileSync(path.join(srcDir, "index.ts"), HEADER + spec.index);
  cpSync(path.join(root, "LICENSE"), path.join(dir, "LICENSE"));
  const tsc = path.join(root, "node_modules/typescript/bin/tsc");
  const r = spawnSync(process.execPath, [tsc, "-p", path.join(dir, "tsconfig.json")], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  console.log(`built ${pkg.name}@${pkg.version} → packages/${name}/dist`);
}
