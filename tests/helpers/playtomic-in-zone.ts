// Run by tests/scrape-playtomic.test.ts in a child process whose TZ is set before it starts. A zone
// changed by assigning process.env.TZ inside a running test is not reliable (a worker thread ignores it,
// and CI's real-Postgres run did too), so the host-zone guard needs a process that starts in that zone.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parsePlaytomicAvailability, parsePlaytomicClubPage } from "@/lib/booking/adapters/playtomic";

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, "../fixtures/scrape/playtomic", name), "utf8");
const club = parsePlaytomicClubPage(fixture("club-the-padel-co.html"));
const slots = club ? parsePlaytomicAvailability(fixture("availability-the-padel-co-2026-10-11.json"), club) : null;
process.stdout.write(JSON.stringify({ hostMidnight: new Date("2026-10-11T00:00:00").toISOString(), slots: slots?.map((s) => [s.start, s.end, s.court]) ?? null }));
