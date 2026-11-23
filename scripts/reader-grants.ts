/**
 * Prints the read-only role's grants for the schema as it stands (src/lib/db/readonly.ts).
 *
 * A new column is not visible to /api/admin/sql until a migration grants it, and
 * tests/readonly.test.ts fails until the newest grants migration matches this output. So, after a
 * schema change:
 *
 *   pnpm exec drizzle-kit generate --custom --name reader_grants
 *   pnpm exec tsx scripts/reader-grants.ts > drizzle/<that file>.sql
 *   node scripts/reader-grants-stub.mjs          (the older grants migrations keep the role only: each
 *                                                 full copy is 17 KB in every function of every deployment)
 */
import { readerGrantsSql } from "../src/lib/db/readonly";

process.stdout.write(readerGrantsSql());
