import "dotenv/config";
import { getDb } from "../src/db";
import { seedIfEmpty } from "../src/db/seed";

// Inside a function for the same reason as scripts/migrate.ts: tsx compiles this to CommonJS, and a
// top-level `await` there is a build error, not a language feature.
async function main() {
  const db = await getDb();
  const seeded = await seedIfEmpty(db);
  console.log(seeded ? "✓ seeded example matches (codes: PLAY, PAST)" : "· database already has events, nothing seeded");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
