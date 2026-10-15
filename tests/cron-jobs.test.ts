import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { CRON_JOBS, CRON_LOG_CLEANUP, CRON_SECRET_NAME, jobCommand, listCronJobs, scheduleCronJobs, storeCronSecret, cronAvailable } from "@/lib/ops/cronJobs";

/**
 * The scheduled jobs, in the repository (migration 0069).
 *
 * Production's pg_cron, pg_net and Vault do not exist in a test database, so the migration's real
 * work would otherwise run for the first time in production, where a mistake stops the Migrate
 * workflow for every migration after it. These tests build stand-ins with the same names and
 * signatures in a fresh database, put hand-made jobs in them the way production had them, and run
 * the migration file itself.
 */

const MIGRATION = readFileSync("drizzle/0069_cron_jobs_in_the_repo.sql", "utf8");
const OLD = "s3cret-0123456789abcdef";

const STANDINS = `
  create role kicksmash_reader nologin;
  create schema cron; create schema vault; create schema net;
  create table cron.job (jobid bigserial primary key, jobname text unique, schedule text not null, command text not null, active boolean not null default true);
  create table cron.job_run_details (runid bigserial primary key, jobid bigint, status text, start_time timestamptz, end_time timestamptz, return_message text);
  create function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
    insert into cron.job (jobname, schedule, command) values (job_name, schedule, command)
    on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
  create function cron.unschedule(job_id bigint) returns boolean language sql as $$ delete from cron.job where jobid = job_id returning true $$;
  create table vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text);
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description from vault.secrets;
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '', new_key_id uuid default null) returns uuid language sql as $$
    insert into vault.secrets (name, secret, description) values (new_name, new_secret, new_description) returning id $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default '', new_key_id uuid default null) returns void language sql as $$
    update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
  create function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language sql as $$ select 1::bigint $$;
`;

async function database(withStandins = true) {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const pg = new PGlite();
  if (withStandins) await pg.exec(STANDINS);
  return { pg, db: drizzle(pg) as unknown as Db };
}

const jobs = async (pg: { query: <T>(q: string) => Promise<{ rows: T[] }> }) =>
  (await pg.query<{ jobname: string | null; schedule: string; command: string }>("select jobname, schedule, command from cron.job order by jobname")).rows;
const secrets = async (pg: { query: <T>(q: string) => Promise<{ rows: T[] }> }) =>
  (await pg.query<{ name: string; secret: string }>("select name, secret from vault.secrets order by name")).rows;

describe("the scheduled jobs live in the repository", () => {
  it("replaces the jobs typed by hand, and moves their secret into Vault", async () => {
    const { pg } = await database();
    // The shapes a hand-made job takes: the header as JSON text, or built; a name, or none.
    await pg.exec(`
      insert into cron.job (jobname, schedule, command) values
        (null, '7 * * * *', 'select net.http_get(url:=''https://kicksma.sh/api/cron/hourly'', headers:=''{"Authorization": "Bearer ${OLD}"}''::jsonb)'),
        ('push-every-5', '*/5 * * * *', 'select net.http_get(url:=''https://kicksma.sh/api/cron/push'', headers:=jsonb_build_object(''Authorization'',''Bearer ${OLD}''))'),
        ('kicksmash-sync', '*/10 * * * *', 'select net.http_get(url:=''https://kicksma.sh/api/cron/sync'', headers:=jsonb_build_object(''Authorization'',''Bearer ${OLD}''))'),
        ('vacuum-nightly', '0 3 * * *', 'vacuum');
    `);
    await pg.exec(MIGRATION);

    const after = await jobs(pg);
    expect(after.map((j) => j.jobname)).toEqual(["kicksmash-hourly", "kicksmash-push", "kicksmash-sync", "vacuum-nightly"]);
    for (const spec of CRON_JOBS) {
      const job = after.find((j) => j.jobname === spec.name)!;
      expect(job.schedule).toBe(spec.schedule);
      // The migration and the code write the same command, character for character.
      expect(job.command).toBe(jobCommand("https://kicksma.sh", spec.path));
    }
    expect(after.some((j) => j.command.includes(OLD)), "a job's text still holds the secret").toBe(false);
    expect(await secrets(pg)).toEqual([{ name: CRON_SECRET_NAME, secret: OLD }]);

    // Run twice, change nothing: the Migrate workflow can be re-run by hand.
    await pg.exec(MIGRATION);
    expect(await jobs(pg)).toEqual(after);
    expect(await secrets(pg)).toHaveLength(1);
  });

  it("takes the secret from a Vault entry the old jobs already read", async () => {
    const { pg } = await database();
    await pg.exec(`
      select vault.create_secret('${OLD}', 'cron_secret');
      insert into cron.job (jobname, schedule, command) values ('push', '*/5 * * * *',
        'select net.http_get(url:=''https://kicksma.sh/api/cron/push'', headers:=jsonb_build_object(''Authorization'', ''Bearer '' || (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')))');
    `);
    await pg.exec(MIGRATION);
    expect((await secrets(pg)).find((s) => s.name === CRON_SECRET_NAME)?.secret).toBe(OLD);
  });

  it("schedules the jobs on a database that had none, and the operator's call stores the secret", async () => {
    const { pg, db } = await database();
    await pg.exec(MIGRATION);
    expect((await jobs(pg)).map((j) => j.jobname)).toEqual(CRON_JOBS.map((j) => j.name));
    expect(await secrets(pg)).toEqual([]); // nothing to move, and nothing made up

    expect(await cronAvailable(db)).toBe(true);
    expect(await storeCronSecret(db, "from-the-app-0123456789")).toBe("created");
    expect(await storeCronSecret(db, "rotated-0123456789abc")).toBe("updated");
    expect(await secrets(pg)).toEqual([{ name: CRON_SECRET_NAME, secret: "rotated-0123456789abc" }]);

    // A job typed by hand later under another name is a second copy of the same work: it goes.
    await pg.exec(`insert into cron.job (jobname, schedule, command) values ('extra', '*/5 * * * *', 'select net.http_get(url:=''https://kicksma.sh/api/cron/push'')')`);
    await scheduleCronJobs(db, "https://kicksma.sh");
    expect((await jobs(pg)).map((j) => j.jobname)).toEqual(CRON_JOBS.map((j) => j.name));

    const listed = await listCronJobs(db);
    expect(listed.map((j) => j.jobname)).toEqual(CRON_JOBS.map((j) => j.name));
    expect(Object.keys(listed[0])).not.toContain("command");
  });

  it("lets the read-only door see the jobs, never a job's text", async () => {
    const { pg } = await database();
    await pg.exec(MIGRATION);
    const can = async (column: string) =>
      (await pg.query<{ ok: boolean }>(`select has_column_privilege('kicksmash_reader', 'cron.job', '${column}', 'select') as ok`)).rows[0].ok;
    expect(await can("jobname")).toBe(true);
    expect(await can("schedule")).toBe(true);
    expect(await can("command")).toBe(false);
  });

  it("does nothing on a database without pg_cron, which is every local and test database", async () => {
    const { pg, db } = await database(false);
    await pg.exec(MIGRATION);
    expect(await cronAvailable(db)).toBe(false);
  });

  it("refuses a command that would call anything but a cron route over https", () => {
    expect(() => jobCommand("http://kicksma.sh", "/api/cron/push")).toThrow();
    expect(() => jobCommand("https://kicksma.sh'; drop table x; --", "/api/cron/push")).toThrow();
    expect(jobCommand("https://kicksma.sh/", "/api/cron/push")).toContain("url := 'https://kicksma.sh/api/cron/push'");
  });
});

/**
 * pg_cron's run log, cleared once a week (migration 0101, the owner's decision of 15 October 2026).
 * The stand-ins above are the same; this runs 0101 after 0069, as production will, and then runs the
 * job's own stored command, which is what pg_cron runs each Sunday.
 */
const CLEANUP = readFileSync("drizzle/0101_cron_log_cleanup.sql", "utf8");

describe("a weekly job clears pg_cron's run log", () => {
  it("schedules one cleanup job beside the three, as the code defines it, however often it runs", async () => {
    const { pg, db } = await database();
    await pg.exec(MIGRATION);
    const three = await jobs(pg);
    await pg.exec(CLEANUP);

    const after = await jobs(pg);
    expect(after.map((j) => j.jobname)).toEqual(["kicksmash-cron-log-cleanup", "kicksmash-hourly", "kicksmash-push", "kicksmash-sync"]);
    const job = after.find((j) => j.jobname === CRON_LOG_CLEANUP.name)!;
    expect(job.schedule).toBe(CRON_LOG_CLEANUP.schedule);
    expect(job.command).toBe(CRON_LOG_CLEANUP.command);
    expect(after.filter((j) => j.jobname !== CRON_LOG_CLEANUP.name), "the three jobs that call the app changed").toEqual(three);

    // Run twice, still one job (the Migrate workflow can be re-run by hand).
    await pg.exec(CLEANUP);
    expect(await jobs(pg)).toEqual(after);

    // The operator's list shows it, and a later POST /api/admin/cron leaves it where it is.
    expect((await listCronJobs(db)).map((j) => j.jobname)).toEqual(after.map((j) => j.jobname));
    await scheduleCronJobs(db, "https://kicksma.sh");
    expect(await jobs(pg)).toEqual(after);
  });

  it("deletes only the run log's rows that ended more than 14 days ago", async () => {
    const { pg } = await database();
    await pg.exec(MIGRATION);
    await pg.exec(CLEANUP);
    // The job reads the database's clock, so the rows are placed against that clock, not the calendar.
    await pg.exec(`
      insert into cron.job_run_details (jobid, status, start_time, end_time, return_message) values
        (1, 'succeeded', now() - interval '30 days', now() - interval '30 days', 'a month ago'),
        (2, 'failed', now() - interval '14 days 1 hour', now() - interval '14 days 1 hour', 'just past 14 days'),
        (2, 'succeeded', now() - interval '13 days 23 hours', now() - interval '13 days 23 hours', 'just inside 14 days'),
        (3, 'succeeded', now() - interval '1 day', now() - interval '1 day', 'yesterday'),
        (3, 'running', now() - interval '20 days', null, 'still running');
    `);
    const jobsBefore = await jobs(pg);
    const stored = (await pg.query<{ command: string }>(`select command from cron.job where jobname = '${CRON_LOG_CLEANUP.name}'`)).rows[0].command;
    await pg.exec(stored);

    const left = (await pg.query<{ return_message: string }>("select return_message from cron.job_run_details order by runid")).rows.map((r) => r.return_message);
    expect(left).toEqual(["just inside 14 days", "yesterday", "still running"]);
    expect(await jobs(pg), "the cleanup touched cron.job").toEqual(jobsBefore);
  });

  it("deletes nothing itself and drops nothing: its one delete is the job's command", () => {
    const code = CLEANUP.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(code.match(/\bdelete\b/gi)).toHaveLength(1);
    expect(code).toContain(CRON_LOG_CLEANUP.command);
    expect(code).not.toMatch(/\b(drop|truncate|alter|vacuum)\b/i);
  });

  it("does nothing on a database without pg_cron, which is every local and test database", async () => {
    const { pg, db } = await database(false);
    await pg.exec(CLEANUP);
    expect(await cronAvailable(db)).toBe(false);
    expect((await pg.query<{ c: string | null }>("select to_regclass('cron.job')::text as c")).rows[0].c).toBeNull();
  });
});
