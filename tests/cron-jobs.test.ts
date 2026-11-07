import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { CRON_JOBS, CRON_LOG_CLEANUP, CRON_SECRET_NAME, PUSH_CALLED_KEY, PUSH_GATE, PUSH_TICK_KEY, jobCommand, listCronJobs, scheduleCronJobs, storeCronSecret, cronAvailable } from "@/lib/ops/cronJobs";

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
/** Migration 0104: the gate function, and the block that gives the push job its gate. */
const GATE_FILE = readFileSync("drizzle/0104_push_job_gate.sql", "utf8");
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
      // The migration and the code write the same command, character for character. 0069 wrote the
      // push job with no gate; 0104 adds it (below).
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
    await pg.exec(GATE_FILE);
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
    // The operator's call writes what the migrations wrote: the push job with its gate.
    for (const spec of CRON_JOBS) expect((await jobs(pg)).find((j) => j.jobname === spec.name)!.command).toBe(jobCommand("https://kicksma.sh", spec.path, spec.gated));

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

    // The operator's list shows it, and a later POST /api/admin/cron leaves it where it is (after 0104,
    // which gives the push job the gate the code writes).
    expect((await listCronJobs(db)).map((j) => j.jobname)).toEqual(after.map((j) => j.jobname));
    await pg.exec(GATE_FILE);
    const gated = await jobs(pg);
    await scheduleCronJobs(db, "https://kicksma.sh");
    expect(await jobs(pg)).toEqual(gated);
    expect(gated.find((j) => j.jobname === CRON_LOG_CLEANUP.name)).toEqual(job);
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

/**
 * The push job's gate (migration 0104, the owner's decision of 7 November 2026: "Start the push job only
 * when something is due"). The stand-ins above, 0069 and 0101 first, as production has them. What the
 * function answers is `tests/push-gate.test.ts`; here, what the job does with the answer.
 */
describe("the push job asks the database first, and records its tick", () => {
  /** The job's own table and a gate that answers what the test says, beside a net.http_get that keeps its calls. */
  const RECORDING = `
    create table if not exists public.metrics_daily (day date not null, key text not null, value bigint not null default 0, primary key (day, key));
    create table net.calls (id bigserial primary key, url text, headers jsonb);
    create or replace function net.http_get(url text, params jsonb default '{}', headers jsonb default '{}', timeout_milliseconds integer default 5000) returns bigint language sql as $$
      insert into net.calls (url, headers) values (url, headers) returning id $$;
    create table public.gate_answer (yes boolean);
    insert into public.gate_answer values (false);
    create or replace function public.${PUSH_GATE}(at timestamptz default now()) returns boolean language sql stable as $$ select yes from public.gate_answer $$;
  `;

  it("gives the push job its gate on the host it called, as the code writes it, and touches nothing else", async () => {
    const { pg } = await database();
    const host = "https://staging.example.org";
    const lit = (text: string) => `'${text.replaceAll("'", "''")}'`;
    await pg.exec(`
      insert into cron.job (jobname, schedule, command) values
        ('kicksmash-hourly', '0 * * * *', ${lit(jobCommand(host, "/api/cron/hourly"))}),
        ('kicksmash-push', '*/5 * * * *', ${lit(jobCommand(host, "/api/cron/push"))}),
        ('kicksmash-sync', '*/10 * * * *', ${lit(jobCommand(host, "/api/cron/sync"))}),
        ('push-by-hand', '*/5 * * * *', ${lit(`select net.http_get(url:='${host}/api/cron/push')`)});
      select vault.create_secret('${OLD}', '${CRON_SECRET_NAME}');
    `);
    await pg.exec(CLEANUP);
    const before = await jobs(pg);
    await pg.exec(GATE_FILE);

    const after = await jobs(pg);
    expect(after.map((j) => j.jobname)).toEqual(["kicksmash-cron-log-cleanup", "kicksmash-hourly", "kicksmash-push", "kicksmash-sync"]);
    for (const spec of CRON_JOBS) expect(after.find((j) => j.jobname === spec.name)!.command).toBe(jobCommand(host, spec.path, spec.gated));
    // The push job alone changed: the others, the run log's cleanup and the secret are as they were.
    expect(after.filter((j) => j.jobname !== "kicksmash-push")).toEqual(before.filter((j) => j.jobname !== "kicksmash-push" && j.jobname !== "push-by-hand"));
    expect(after.find((j) => j.jobname === "kicksmash-push")!.schedule).toBe("*/5 * * * *");
    expect(await secrets(pg)).toEqual([{ name: CRON_SECRET_NAME, secret: OLD }]);
    expect(after.some((j) => j.command.includes(OLD)), "a job's text holds the secret").toBe(false);

    // Run twice, change nothing (the Migrate workflow can be re-run by hand).
    await pg.exec(GATE_FILE);
    expect(await jobs(pg)).toEqual(after);
  });

  it("the operator's call before 0104 keeps the push job without its gate, and says so", async () => {
    // A gated job on a database with no kicksmash_push_due would fail on every tick and call nothing.
    const { pg, db } = await database();
    await pg.exec(MIGRATION);
    expect(await scheduleCronJobs(db, "https://kicksma.sh")).toEqual({ pushGated: false });
    expect((await jobs(pg)).find((j) => j.jobname === "kicksmash-push")!.command).toBe(jobCommand("https://kicksma.sh", "/api/cron/push"));
    // Once 0104 is in, the same call gives it the gate.
    await pg.exec(GATE_FILE);
    expect(await scheduleCronJobs(db, "https://kicksma.sh")).toEqual({ pushGated: true });
    expect((await jobs(pg)).find((j) => j.jobname === "kicksmash-push")!.command).toBe(jobCommand("https://kicksma.sh", "/api/cron/push", true));
  });

  it("takes kicksma.sh when no job names a host, as 0069 does", async () => {
    const { pg } = await database();
    await pg.exec(GATE_FILE);
    expect((await jobs(pg)).map((j) => [j.jobname, j.command])).toEqual([["kicksmash-push", jobCommand("https://kicksma.sh", "/api/cron/push", true)]]);
  });

  it("writes its tick on every run, and calls the app, once, only on a yes", async () => {
    const { pg } = await database();
    await pg.exec(MIGRATION);
    await pg.exec(GATE_FILE);
    await pg.exec(RECORDING);
    await pg.exec(`select vault.create_secret('${OLD}', '${CRON_SECRET_NAME}')`);
    const command = (await pg.query<{ command: string }>("select command from cron.job where jobname = 'kicksmash-push'")).rows[0].command;
    const metric = async (key: string) => (await pg.query<{ value: number; fresh: boolean; today: boolean }>(`select value, abs(value - extract(epoch from now())) < 60 as fresh, day = (now() at time zone 'UTC')::date as today from public.metrics_daily where key = '${key}'`)).rows;
    const calls = async () => (await pg.query<{ url: string; auth: string }>("select url, headers->>'Authorization' as auth from net.calls order by id")).rows;

    // Nothing due: the tick, and no call.
    await pg.exec(command);
    expect(await metric(PUSH_TICK_KEY)).toEqual([{ value: expect.any(Number), fresh: true, today: true }]);
    expect(await metric(PUSH_CALLED_KEY)).toEqual([]);
    expect(await calls()).toEqual([]);

    // Something due: the tick, the call recorded, and one GET with the secret from Vault.
    await pg.exec("update public.gate_answer set yes = true");
    await pg.exec(command);
    expect(await metric(PUSH_TICK_KEY)).toHaveLength(1); // one row a day, written over
    expect(await metric(PUSH_CALLED_KEY)).toEqual([{ value: expect.any(Number), fresh: true, today: true }]);
    expect(await calls()).toEqual([{ url: "https://kicksma.sh/api/cron/push", auth: `Bearer ${OLD}` }]);

    // A gate that fails outright (dropped, say) stops the job, and with it the tick: the board turns red.
    await pg.exec(`update public.metrics_daily set value = 0; drop function public.${PUSH_GATE}(timestamptz)`);
    await expect(pg.exec(command)).rejects.toThrow();
    expect(Number((await metric(PUSH_TICK_KEY))[0].value)).toBe(0);
    expect(await calls()).toHaveLength(1);
  });

  it("makes the function and touches no job on a database without pg_cron, which is every local and test database", async () => {
    const { pg, db } = await database(false);
    await pg.exec(GATE_FILE);
    expect(await cronAvailable(db)).toBe(false);
    expect((await pg.query<{ f: string | null }>(`select to_regprocedure('public.${PUSH_GATE}(timestamptz)')::text as f`)).rows[0].f).toBe(`${PUSH_GATE}(timestamp with time zone)`);
  });

  it("refuses the function to everybody but its owner and the app's own role: no API role may call it", async () => {
    const { pg } = await database(false);
    await pg.exec("create role anon nologin; create role authenticated nologin; create role somebody nologin; create role kicksmash nologin;");
    await pg.exec(GATE_FILE);
    const can = async (role: string) => (await pg.query<{ ok: boolean }>(`select has_function_privilege('${role}', 'public.${PUSH_GATE}(timestamptz)', 'execute') as ok`)).rows[0].ok;
    for (const role of ["anon", "authenticated", "somebody"]) expect([role, await can(role)]).toEqual([role, false]);
    // The app may move onto the role kicksmash one day (AGENTS.md rule 10): the job must still run then.
    expect(await can("kicksmash")).toBe(true);
  });
});

