-- pg_cron's own run log, cleared once a week. The owner's decision of 15 October 2026:
-- "Yes, weekly cleanup (Recommended)".
--
-- pg_cron writes one row to cron.job_run_details for each run of each job, and nothing deleted them.
-- On 15 October 2026 production held 18,071 rows there (7.27 MB, the largest relation in a 32 MB
-- database), and 456 more arrive each day: 288 from the five-minute push job, 144 from the ten-minute
-- calendar sync, 24 from the hourly job. 11,687 of those rows ended more than 14 days ago.
--
-- This schedules one job, kicksmash-cron-log-cleanup, at 03:17 UTC each Sunday, a quiet hour. It
-- deletes the run log's rows that ended more than 14 days ago, and nothing else. A run that is still
-- going has no end_time, so it stays. src/lib/ops/cronJobs.ts holds the same definition
-- (CRON_LOG_CLEANUP), and tests/cron-jobs.test.ts holds the two together and runs the job's command.
--
-- Additive, as AGENTS.md rule 7 asks: it adds a job and drops nothing. The only rows the job ever
-- deletes are pg_cron's own log rows older than 14 days, in a table that pg_cron owns and the app does
-- not. The app reads that table for one thing only, each job's last run (listCronJobs), and a weekly
-- run keeps between 14 and 21 days of it. This file deletes no row itself: the first Sunday run does.
-- Running it twice leaves one job. Where pg_cron is missing (local, tests, CI) it does nothing.
do $migration$
declare
  job record;
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('cron.unschedule(bigint)') is null
     or to_regclass('cron.job_run_details') is null then
    raise notice 'pg_cron is not here: no cleanup job scheduled.';
    return;
  end if;

  -- A job of this name goes first, so a second run of this file leaves one job, not two.
  for job in execute 'select jobid from cron.job where jobname = $1' using 'kicksmash-cron-log-cleanup' loop
    execute 'select cron.unschedule($1::bigint)' using job.jobid;
  end loop;
  execute 'select cron.schedule($1, $2, $3)' using
    'kicksmash-cron-log-cleanup',
    '17 3 * * 0',
    $c$delete from cron.job_run_details where end_time < now() - interval '14 days'$c$;
end
$migration$;
