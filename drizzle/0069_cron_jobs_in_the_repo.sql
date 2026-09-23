-- The three scheduled jobs, in the repository at last (src/lib/ops/cronJobs.ts holds the same list,
-- and tests/cron-jobs.test.ts holds the two together). Until this file they existed only in
-- Supabase's cron.job, typed there by hand with the operator secret written into each job's text,
-- so a database rebuilt from GitHub would have had no reminders, no calendar sync and no hourly job.
--
-- The secret is never in this file. Each job reads it from Vault when it runs. This moves it into
-- Vault from the jobs it replaces; a database that had none gets it from POST /api/admin/cron, which
-- stores the app's own CRON_SECRET. Nothing here prints a job's text: the Migrate workflow's log is
-- public. Where pg_cron, pg_net or Vault is missing (local, tests, CI) it does nothing.
do $migration$
declare
  secret text;
  base text;
  job record;
  spec text[];
  specs text[] := array[
    ['kicksmash-hourly', '0 * * * *', '/api/cron/hourly'],
    ['kicksmash-push', '*/5 * * * *', '/api/cron/push'],
    ['kicksmash-sync', '*/10 * * * *', '/api/cron/sync']
  ];
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron, pg_net or Vault is not here: no jobs scheduled.';
    return;
  end if;

  -- 1. The secret into Vault, once: from a job that carries it, or from a Vault entry a job reads.
  execute 'select decrypted_secret from vault.decrypted_secrets where name = $1' into secret using 'kicksmash_cron_secret';
  if secret is null then
    execute $q$select substring(command from 'Bearer ([A-Za-z0-9._~+/=-]{16,})') from cron.job
      where command ~ '/api/cron/(hourly|push|sync)' and command ~ 'Bearer [A-Za-z0-9._~+/=-]{16,}' limit 1$q$ into secret;
    if secret is null then
      execute $q$select s.decrypted_secret from cron.job j join vault.decrypted_secrets s
        on s.name is not null and position(quote_literal(s.name) in j.command) > 0
        where j.command ~ '/api/cron/(hourly|push|sync)' limit 1$q$ into secret;
    end if;
    if secret is not null then
      execute 'select vault.create_secret($1, $2, $3)' using secret, 'kicksmash_cron_secret',
        'CRON_SECRET for the pg_cron jobs: the same value as CRON_SECRET on Vercel.';
    else
      raise notice 'No secret found in the old jobs: store the app''s own with POST /api/admin/cron.';
    end if;
  end if;

  -- 2. Where the jobs call: the host the old jobs called, else kicksma.sh.
  execute $q$select substring(command from '(https://[A-Za-z0-9.:-]+)/api/cron/(hourly|push|sync)') from cron.job
    where command ~ '/api/cron/(hourly|push|sync)' limit 1$q$ into base;
  base := coalesce(base, 'https://kicksma.sh');

  -- 3. Every job that calls one of the three routes goes, and the three named jobs take their place.
  for job in execute $q$select jobid, jobname from cron.job where command ~ '/api/cron/(hourly|push|sync)'$q$ loop
    raise notice 'replacing job % (%)', job.jobid, coalesce(job.jobname, 'no name');
    execute 'select cron.unschedule($1::bigint)' using job.jobid;
  end loop;
  foreach spec slice 1 in array specs loop
    execute 'select cron.schedule($1, $2, $3)' using spec[1], spec[2], format(
      $c$select net.http_get(url := %L, headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kicksmash_cron_secret')), timeout_milliseconds := 60000)$c$,
      base || spec[3]);
  end loop;

  -- 4. The read-only door may see the jobs and how their runs went, never a job's text.
  execute 'grant usage on schema cron to kicksmash_reader';
  execute 'grant select (jobid, jobname, schedule, active) on cron.job to kicksmash_reader';
  execute 'grant select (runid, jobid, status, start_time, end_time) on cron.job_run_details to kicksmash_reader';
end
$migration$;
