#!/usr/bin/env node
// The club directory, from data/clubs.json into the database.
//
//   node scripts/import-clubs.mjs --sql     print the statements, apply them yourself (production)
//   node scripts/import-clubs.mjs           run them against DATABASE_URL
//   node scripts/import-clubs.mjs --dry-run say what would change, touch nothing
//
// Two rules decide everything here:
//
// 1. A club owner's edits win. The import only ever writes rows that are still the directory's —
//    `source = 'directory'` and nobody has claimed them. The moment an owner claims their page it
//    stops listening to this file, for good.
// 2. A value nobody published stays null. The file has nulls where no source said, and a null here
//    never overwrites something already in the row: coalesce, not assignment.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const root = (p) => path.resolve(process.cwd(), p);
const { clubs } = JSON.parse(readFileSync(root("data/clubs.json"), "utf8"));
const q = (v) => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const token = () => randomBytes(18).toString("base64url").slice(0, 24);

/** A slug the app will accept: lowercase, digits and hyphens, the same shape venueSlug() makes. */
const valid = (s) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= 80;

const bad = clubs.filter((c) => !valid(c.slug) || !c.name || !c.country || !c.province);
if (bad.length) {
  console.error(`✗ ${bad.length} row(s) in data/clubs.json are not usable:`);
  for (const c of bad) console.error(`  ${c.slug ?? "(no slug)"} — a slug, a name, a country and a province are all required`);
  process.exit(1);
}

// One statement, not sixty-three: the same upsert over a VALUES list. Easier to read, easier to
// apply by hand, and there is exactly one guard to check rather than one per club.
const row = (c) => {
  const about = c.area ? `${c.name}, ${c.area}.` : null;
  return `  (${[c.slug, c.name, c.country, c.province, c.city, c.tz, c.courts, c.courtsIndoor, c.courtsOutdoor, c.website, about, token()].map(q).join(", ")})`;
};
const statement = `insert into clubs (slug, name, country, province, city, tz, courts, courts_indoor, courts_outdoor, website, about, manage_token, source)
select v.slug, v.name, v.country, v.province, v.city, v.tz, v.courts::int, v.courts_indoor::int, v.courts_outdoor::int, v.website, v.about, v.manage_token, 'directory'
from (values
${clubs.map(row).join(",\n")}
) as v (slug, name, country, province, city, tz, courts, courts_indoor, courts_outdoor, website, about, manage_token)
on conflict (slug) do update set
  name = excluded.name,
  country = coalesce(excluded.country, clubs.country),
  province = coalesce(excluded.province, clubs.province),
  city = coalesce(excluded.city, clubs.city),
  tz = coalesce(clubs.tz, excluded.tz),
  courts = coalesce(excluded.courts, clubs.courts),
  courts_indoor = coalesce(excluded.courts_indoor, clubs.courts_indoor),
  courts_outdoor = coalesce(excluded.courts_outdoor, clubs.courts_outdoor),
  website = coalesce(clubs.website, excluded.website),
  about = coalesce(clubs.about, excluded.about),
  updated_at = now()
where clubs.source = 'directory' and clubs.claimed_by is null;`;

if (process.argv.includes("--sql")) {
  console.log(`-- ${clubs.length} clubs from data/clubs.json`);
  console.log(statement);
  process.exit(0);
}

if (process.argv.includes("--dry-run")) {
  console.log(`${clubs.length} clubs would be written; rows a club owner has claimed are left alone.`);
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("✗ DATABASE_URL is not set. Use --sql and apply the statements yourself, or --dry-run.");
  process.exit(1);
}
const postgres = (await import("postgres")).default;
const sql = postgres(url, { max: 1, prepare: false });
try {
  await sql.unsafe(statement);
  const [{ n }] = await sql`select count(*)::int as n from clubs where source = 'directory'`;
  console.log(`✓ ${clubs.length} clubs from the file; ${n} directory rows in the database`);
} finally {
  await sql.end();
}
