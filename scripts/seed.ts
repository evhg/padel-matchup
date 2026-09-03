import "dotenv/config";
import { getDb } from "../src/db";
import { seedIfEmpty } from "../src/db/seed";

const db = await getDb();
const seeded = await seedIfEmpty(db);
console.log(seeded ? "✓ seeded example matches (codes: PLAY, PAST)" : "· database already has events, nothing seeded");
process.exit(0);
