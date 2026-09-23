import { sql } from "drizzle-orm";
import type { Db } from "@/db";

/**
 * The three scheduled jobs, in the repository.
 *
 * Vercel's Hobby plan runs one cron a day, so the frequent work runs from Supabase `pg_cron`, which
 * calls the app through `pg_net`. Until migration 0069 those jobs existed only in the database's
 * `cron.job`, typed there by hand, with the operator secret written into each job's text. A database
 * rebuilt from GitHub would have had no reminders, no calendar sync and no hourly job, and nobody
 * reading the repository could have said what ran when.
 *
 * Now the definitions live here and in the migration (`tests/cron-jobs.test.ts` holds the two
 * together), and no job's text holds the secret: each job reads it from Supabase Vault when it runs.
 * The migration moved the secret into Vault from the jobs it replaced. On a database that never had
 * jobs, `POST /api/admin/cron` stores the app's own `CRON_SECRET` there, and after `CRON_SECRET`
 * changes on Vercel the same call brings Vault back in step. That makes rotating the secret one call
 * rather than an edit of three jobs.
 */
export const CRON_SECRET_NAME = "kicksmash_cron_secret";

export const CRON_JOBS = [
  { name: "kicksmash-hourly", schedule: "0 * * * *", path: "/api/cron/hourly" },
  { name: "kicksmash-push", schedule: "*/5 * * * *", path: "/api/cron/push" },
  { name: "kicksmash-sync", schedule: "*/10 * * * *", path: "/api/cron/sync" },
] as const;

/** As long as the routes may run (`maxDuration = 60`), so a slow run is not recorded as a failure. */
export const CRON_TIMEOUT_MS = 60_000;

/** Any job that calls one of the three routes, whatever it was named by hand. */
const CRON_ROUTE = "/api/cron/(hourly|push|sync)";

/** The SQL a job runs: a GET with the secret read from Vault at run time. */
export function jobCommand(base: string, path: string): string {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  if (!/^https:\/\/[A-Za-z0-9.:-]+\/api\/cron\/[a-z]+$/.test(url)) throw new Error(`not a cron url: ${url}`);
  return (
    `select net.http_get(url := '${url}', headers := jsonb_build_object('Authorization', 'Bearer ' || ` +
    `(select decrypted_secret from vault.decrypted_secrets where name = '${CRON_SECRET_NAME}')), timeout_milliseconds := ${CRON_TIMEOUT_MS})`
  );
}

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? r : ((r as { rows?: T[] }).rows ?? [])) as T[];

/** pg_cron, pg_net and Vault are all here. False on a local or test database, which have none of them. */
export async function cronAvailable(db: Db): Promise<boolean> {
  const [row] = rowsOf<{ ok: boolean }>(
    await db.execute(
      sql`select (to_regprocedure('cron.schedule(text,text,text)') is not null and to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is not null and to_regclass('vault.decrypted_secrets') is not null) as ok`,
    ),
  );
  return Boolean(row?.ok);
}

export type CronJobRow = { jobid: number; jobname: string | null; schedule: string; active: boolean; lastStatus: string | null; lastStart: string | null };

/** The jobs that call the app, and how each one's last run went. Never a job's text. */
export async function listCronJobs(db: Db): Promise<CronJobRow[]> {
  return rowsOf<CronJobRow>(
    await db.execute(sql`
      select j.jobid, j.jobname, j.schedule, j.active, r.status as "lastStatus", r.start_time::text as "lastStart"
      from cron.job j
      left join lateral (select status, start_time from cron.job_run_details d where d.jobid = j.jobid order by start_time desc limit 1) r on true
      where j.command ~ ${CRON_ROUTE}
      order by j.jobname`),
  );
}

/** Stores the secret the jobs send, creating or replacing the Vault entry. The value is never returned. */
export async function storeCronSecret(db: Db, secret: string): Promise<"created" | "updated"> {
  const [existing] = rowsOf<{ id: string }>(await db.execute(sql`select id from vault.secrets where name = ${CRON_SECRET_NAME}`));
  if (existing) {
    await db.execute(sql`select vault.update_secret(${existing.id}::uuid, ${secret})`);
    return "updated";
  }
  await db.execute(sql`select vault.create_secret(${secret}, ${CRON_SECRET_NAME}, ${"CRON_SECRET for the pg_cron jobs: the same value as CRON_SECRET on Vercel."})`);
  return "created";
}

/**
 * The three jobs, by name, and nothing else calling the same routes: a job typed by hand under
 * another name would run the same work twice, so it goes. The same result as migration 0069.
 */
export async function scheduleCronJobs(db: Db, base: string): Promise<void> {
  const names = sql.join(
    CRON_JOBS.map((j) => sql`${j.name}`),
    sql`, `,
  );
  const strays = rowsOf<{ jobid: number }>(await db.execute(sql`select jobid from cron.job where command ~ ${CRON_ROUTE} and (jobname is null or jobname not in (${names}))`));
  for (const s of strays) await db.execute(sql`select cron.unschedule(${s.jobid}::bigint)`);
  for (const job of CRON_JOBS) await db.execute(sql`select cron.schedule(${job.name}, ${job.schedule}, ${jobCommand(base, job.path)})`);
}
