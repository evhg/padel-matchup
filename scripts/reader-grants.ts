/**
 * Prints the read-only role's grants for the schema as it stands (src/lib/db/readonly.ts).
 *
 * A new column is not visible to /api/admin/sql until a migration grants it, and
 * tests/readonly.test.ts fails until the newest grants migration matches this output. So, after a
 * schema change:
 *
 *   pnpm exec drizzle-kit generate --custom --name reader_grants
 *   pnpm exec tsx scripts/reader-grants.ts > drizzle/<that file>.sql
 */
import { readerGrantsSql } from "../src/lib/db/readonly";

process.stdout.write(readerGrantsSql());
