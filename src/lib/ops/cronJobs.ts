import { sql } from "drizzle-orm";
import type { Db } from "@/db";

/**
 * The scheduled jobs, in the repository: three that call the app, and one that clears pg_cron's log.
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

/**
 * The push job calls the app only when something is due (migration 0104; the owner's decision of
 * 7 November 2026, "Start the push job only when something is due"). `kicksmash_push_due()` asks the
 * database first: a reminder, a card to refresh, a coach's offer, request or lesson, a tournament
 * match, or the court reader's turn. Until then the job called the app every five minutes, 288 times
 * a day, and nearly every call found nothing to do. The function is a superset of what the route does
 * (`tests/push-gate.test.ts`), and it says yes on any error of its own.
 *
 * On every run, called or not, the job writes its tick (`PUSH_TICK_KEY`, epoch seconds), and when it
 * calls the app, the call (`PUSH_CALLED_KEY`), in `metrics_daily`. The service board judges pg_cron by
 * the tick and the app by its own `cron_push_at` (`pushJobHealth` in `services.ts`), so a quiet night
 * stays green and a job that stopped, or an app that does not answer, turns red.
 */
export const PUSH_GATE = "kicksmash_push_due";
export const PUSH_TICK_KEY = "cron_push_tick_at";
export const PUSH_CALLED_KEY = "cron_push_called_at";

/** `gated`: the job asks `kicksmash_push_due()` first and calls the route only on a yes (`jobCommand`). */
export const CRON_JOBS = [
  { name: "kicksmash-hourly", schedule: "0 * * * *", path: "/api/cron/hourly", gated: false },
  { name: "kicksmash-push", schedule: "*/5 * * * *", path: "/api/cron/push", gated: true },
  { name: "kicksmash-sync", schedule: "*/10 * * * *", path: "/api/cron/sync", gated: false },
] as const;

/**
 * The fourth job calls nothing: it clears pg_cron's own run log (migration 0101, the owner's decision
 * of 15 October 2026). pg_cron writes a row to `cron.job_run_details` for each run, 456 a day, and
 * nothing deleted them: 18,071 rows and 7.27 MB on 15 October, the largest relation in the database.
 * Each Sunday at 03:17 UTC the job deletes the rows that ended more than 14 days ago, so the log keeps
 * 14 to 21 days. So `listCronJobs` shows the last run of each job that runs at least once in 14 days,
 * which the four scheduled jobs do. A job paused for 14 days or more shows no last run (null).
 * `tests/cron-jobs.test.ts` holds this to the migration. It needs pg_cron only, no secret, so
 * `POST /api/admin/cron` leaves it alone.
 */
export const CRON_LOG_CLEANUP = {
  name: "kicksmash-cron-log-cleanup",
  schedule: "17 3 * * 0",
  command: "delete from cron.job_run_details where end_time < now() - interval '14 days'",
} as const;

/** As long as the routes may run (`maxDuration = 60`), so a slow run is not recorded as a failure. */
export const CRON_TIMEOUT_MS = 60_000;

/** Any job that calls one of the three routes, whatever it was named by hand. */
const CRON_ROUTE = "/api/cron/(hourly|push|sync)";

/**
 * The SQL a job runs: a GET with the secret read from Vault at run time. A gated job (the push job,
 * migration 0104) is one statement: it asks `kicksmash_push_due()` once, writes its tick (and the call,
 * on a yes) into `metrics_daily` as `setMetric` would (the UTC day, the key, the epoch seconds), and
 * calls the route only on a yes. Migration 0104 writes the same text, character for character.
 */
export function jobCommand(base: string, path: string, gated = false): string {
  const url = `${base.replace(/\/+$/, "")}${path}`;
  if (!/^https:\/\/[A-Za-z0-9.:-]+\/api\/cron\/[a-z]+$/.test(url)) throw new Error(`not a cron url: ${url}`);
  const get =
    `select net.http_get(url := '${url}', headers := jsonb_build_object('Authorization', 'Bearer ' || ` +
    `(select decrypted_secret from vault.decrypted_secrets where name = '${CRON_SECRET_NAME}')), timeout_milliseconds := ${CRON_TIMEOUT_MS})`;
  if (!gated) return get;
  return (
    `with due as (select public.${PUSH_GATE}() as yes), ` +
    `tick as (insert into public.metrics_daily (day, key, value) select (now() at time zone 'UTC')::date, k, floor(extract(epoch from now()))::bigint ` +
    `from due, unnest(array['${PUSH_TICK_KEY}', '${PUSH_CALLED_KEY}']) as k where k = '${PUSH_TICK_KEY}' or due.yes ` +
    `on conflict (day, key) do update set value = excluded.value) ` +
    `${get} from due where due.yes`
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

/** The jobs that call the app and the run log's cleanup, and how each one's last run went. Never a job's text. */
export async function listCronJobs(db: Db): Promise<CronJobRow[]> {
  return rowsOf<CronJobRow>(
    await db.execute(sql`
      select j.jobid, j.jobname, j.schedule, j.active, r.status as "lastStatus", r.start_time::text as "lastStart"
      from cron.job j
      left join lateral (select status, start_time from cron.job_run_details d where d.jobid = j.jobid order by start_time desc limit 1) r on true
      where j.command ~ ${CRON_ROUTE} or j.jobname = ${CRON_LOG_CLEANUP.name}
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

/** Is the push job's gate in this database (migration 0104)? */
export async function pushGateAvailable(db: Db): Promise<boolean> {
  const [row] = rowsOf<{ ok: boolean }>(await db.execute(sql`select to_regprocedure(${`public.${PUSH_GATE}(timestamptz)`}) is not null as ok`));
  return Boolean(row?.ok);
}

/**
 * The three jobs, by name, and nothing else calling the same routes: a job typed by hand under
 * another name would run the same work twice, so it goes. The same result as migrations 0069 and 0104.
 * The push job gets its gate only where `kicksmash_push_due` exists: on a database that has not had
 * 0104 yet, a gated job would fail on every tick and call nothing, so it gets the command from before
 * 0104 instead, and the answer says so (`pushGated: false`); the Migrate workflow's 0104 then gives it
 * the gate.
 */
export async function scheduleCronJobs(db: Db, base: string): Promise<{ pushGated: boolean }> {
  const gate = await pushGateAvailable(db);
  const names = sql.join(
    CRON_JOBS.map((j) => sql`${j.name}`),
    sql`, `,
  );
  const strays = rowsOf<{ jobid: number }>(await db.execute(sql`select jobid from cron.job where command ~ ${CRON_ROUTE} and (jobname is null or jobname not in (${names}))`));
  for (const s of strays) await db.execute(sql`select cron.unschedule(${s.jobid}::bigint)`);
  for (const job of CRON_JOBS) await db.execute(sql`select cron.schedule(${job.name}, ${job.schedule}, ${jobCommand(base, job.path, job.gated && gate)})`);
  return { pushGated: gate };
}
