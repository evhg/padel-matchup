-- The push job calls the app only when something is due. The owner's decision of 7 November 2026:
-- "Start the push job only when something is due. The database checks first, and it calls the app
-- only when a notification waits."
--
-- Until this file, pg_cron called /api/cron/push every five minutes, 288 times a day, and nearly every
-- call found nothing to do: 1 match in 14 days and 2 push subscriptions on 7 November 2026. Each call
-- still started a Vercel function, and the scheduled jobs used about 95% of the Hobby plan's 4 hours
-- of active CPU a month. Now the job asks kicksmash_push_due() first, in the database, and calls the
-- app only on a yes.
--
-- kicksmash_push_due(at) is a superset of what the route does at `at` and a few minutes later (the
-- app's clock reads a little after the database's tick): it may say yes when the route then finds
-- nothing, and it never says no when the route would do something. Each clause names the code it
-- covers. tests/push-gate.test.ts runs this function's own text beside the route's own due functions,
-- and holds every number here to the code's. It never writes, and it says yes on any error of its own,
-- so a fault here costs function time, never a reminder.
--
-- The job also writes its tick into metrics_daily on every run (cron_push_tick_at, and
-- cron_push_called_at when it calls), as setMetric would: the UTC day, the key, the epoch seconds. The
-- service board judges pg_cron by the tick and the app by its own cron_push_at, which may be hours old
-- at night (pushJobHealth in src/lib/ops/services.ts).
--
-- Additive, as AGENTS.md rule 7 asks: one new function, and the push job's command replaced. Nothing is
-- dropped. src/lib/ops/cronJobs.ts writes the same command (jobCommand, gated), so
-- POST /api/admin/cron gives the same job, and tests/cron-jobs.test.ts holds the two together. Where
-- pg_cron, pg_net or Vault is missing (local, tests, CI) the function is made and no job is touched.
create or replace function public.kicksmash_push_due(at timestamptz default now()) returns boolean
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $gate$
declare
  t constant timestamptz := coalesce($1, now());
  last_read bigint;
begin
  -- 1. Reminders about an hour before a match. Push: findPushRemindersDue (src/lib/domain/push.ts):
  --    open or full, no push reminder yet, within PUSH_REMINDER_LEAD_MS (60 minutes). Each card channel:
  --    sendReminders (src/lib/channels/cards.ts) with remindersDue of telegram, discord and line: open
  --    or full, within 90 minutes, no reminder in that channel yet, and a card there. Five minutes of slack.
  if exists (
    select 1 from events e
    where e.status in ('open', 'full') and e.starts_at > t and e.starts_at <= t + interval '95 minutes'
      and ((e.push_reminder_sent_at is null and e.starts_at <= t + interval '65 minutes')
        or (e.telegram_reminder_sent_at is null and exists (select 1 from telegram_cards c where c.event_id = e.id and c.kind = 'card'))
        or (e.discord_reminder_sent_at is null and exists (select 1 from discord_cards c where c.event_id = e.id and c.kind = 'card'))
        or (e.line_reminder_sent_at is null and exists (select 1 from line_cards c where c.event_id = e.id and c.kind = 'card')))
  ) then
    return true;
  end if;

  -- 2. Telegram cards of matches that started in the last day and have no locked score grow their
  --    Result button: refreshStarted in src/lib/channels/telegram.ts, which takes only a card last
  --    rendered before the start (updated_at < starts_at; a good edit moves updated_at, a failed one
  --    does not, so it is tried again). Five minutes of slack.
  if exists (
    select 1 from events e
    where e.type = 'match' and e.starts_at <= t + interval '5 minutes' and e.starts_at > t - interval '1 day'
      and e.score_locked_by_creator = false and e.status in ('open', 'full', 'past')
      and (exists (select 1 from telegram_cards c where c.event_id = e.id and c.kind = 'card' and c.updated_at < e.starts_at)
        or exists (select 1 from telegram_inline_cards i where i.event_id = e.id and i.updated_at < e.starts_at))
  ) then
    return true;
  end if;

  -- 3. The coach's book (src/lib/coach/chains.ts). tickWaitlist: an offer past its thirty minutes lapses,
  --    and offerFreedSlot offers that slot to the next in line. expireRequests: an open request whose
  --    time came. lessonRemindersDue: a booked lesson within REMIND_HOURS_BEFORE (20 hours) that has not
  --    been reminded. Six to ten minutes of slack.
  if exists (select 1 from lesson_waitlist w where w.status = 'offered' and w.offer_expires_at < t + interval '6 minutes') then
    return true;
  end if;
  if exists (select 1 from lesson_requests r where r.status = 'open' and r.starts_at <= t + interval '6 minutes') then
    return true;
  end if;
  if exists (
    select 1 from lessons l
    where l.status = 'booked' and l.reminded_at is null and l.starts_at > t and l.starts_at <= t + interval '20 hours 10 minutes'
  ) then
    return true;
  end if;

  -- 4. The serious tournament: matchRemindersDue (src/lib/domain/competitionSchedule.ts): a match not
  --    done and not a walkover, not reminded, COURTS.remindMinutes (15) before its time. Six minutes of
  --    slack, and no condition on its pairs, so it says yes a little more often than the route acts.
  if exists (
    select 1 from competition_matches m
    where m.reminded_at is null and m.status not in ('done', 'walkover')
      and m.scheduled_at > t and m.scheduled_at <= t + interval '21 minutes'
  ) then
    return true;
  end if;

  -- 5. The court reader's turn: scrapeIfDue (src/lib/booking/scrape.ts) runs when its last run
  --    (cron_scrape_at, the newest day's row) began SCRAPE.dueMs (14 minutes) ago or more, and a club
  --    that a lane may pick is in its day hours (anyClubAwake): listed (listedForRead: not refused, and
  --    approved or a source in LISTED_SOURCES), no feed of its own (noFeed: a kind in
  --    AVAILABILITY_KINDS), a booking link or a website on a platform's host (anyPlatformHost, from
  --    PLATFORMS), and 06:00 to 23:00 in its own zone (dayHours; a club with no zone keeps Bangkok's).
  --    Here: the same club, in its day hours now or two minutes from now, and the last run 12 minutes
  --    old or more, so two minutes of slack. A run that SCRAPE_DISABLED=all skips writes
  --    cron_scrape_skipped_at, and that counts as a run here, so a reader switched off does not wake the
  --    job every tick. tests/push-gate.test.ts holds the sources, the kinds and the hosts to the code: a
  --    new platform host needs a new migration that replaces this function.
  select max(m.value) into last_read from metrics_daily m
  where m.key in ('cron_scrape_at', 'cron_scrape_skipped_at') and m.day >= ((t - interval '1 day') at time zone 'UTC')::date;
  if (last_read is null or last_read <= floor(extract(epoch from t)) - 12 * 60) and exists (
    select 1 from clubs c
    where c.rejected_at is null
      and (c.approved_at is not null or c.source in ('directory', 'player'))
      and (c.availability_url is null or c.availability_kind is null or c.availability_kind not in ('ics_bookings', 'json_free'))
      and (c.booking_url is not null or c.website ~* '^https?://([^/?#]*\.)?(playtomic\.io|playtomic\.com|matchi\.se|matchi\.com|playbypoint\.com|padelmates\.se|courtsite\.my|courtsite\.com|skedda\.com|bookandgo\.app|podplay\.app|podify\.club|thepadelsociety\.co|thepadelsociety\.app\.link|getsetpoint\.io)([/?#:]|$)')
      and (extract(hour from (t at time zone coalesce(nullif(c.tz, ''), 'Asia/Bangkok'))) between 6 and 22
        or extract(hour from ((t + interval '2 minutes') at time zone coalesce(nullif(c.tz, ''), 'Asia/Bangkok'))) between 6 and 22)
  ) then
    return true;
  end if;

  return false;
exception when others then
  -- Fail open: a fault here must never cost a reminder. The app then decides, as it did before 0104.
  return true;
end
$gate$;
--> statement-breakpoint
do $migration$
declare
  base text;
  job record;
  r text;
begin
  -- Only the job's owner (and the app's own role, below) runs it. Supabase gives the API roles every new function in public; they get
  -- nothing here (AGENTS.md rule 10).
  execute 'revoke all on function public.kicksmash_push_due(timestamptz) from public';
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on function public.kicksmash_push_due(timestamptz) from %I', r);
    end if;
  end loop;
  -- The app's own role may call it, for the day the app connects as kicksmash (AGENTS.md rule 10).
  if exists (select 1 from pg_roles where rolname = 'kicksmash') then
    execute 'grant execute on function public.kicksmash_push_due(timestamptz) to kicksmash';
  end if;

  if to_regprocedure('cron.schedule(text,text,text)') is null
     or to_regprocedure('net.http_get(text,jsonb,jsonb,integer)') is null
     or to_regclass('vault.decrypted_secrets') is null then
    raise notice 'pg_cron, pg_net or Vault is not here: the push job is not touched.';
    return;
  end if;

  -- 1. Where the job calls: the host the push job calls now, else the host of any job that calls a
  --    cron route, else kicksma.sh, as migration 0069 chose it. The secret stays in Vault, where 0069
  --    put it, and nothing here prints a job's text: the Migrate workflow's log is public.
  execute $q$select substring(command from '(https://[A-Za-z0-9.:-]+)/api/cron/push') from cron.job
    where jobname = 'kicksmash-push' and command ~ '/api/cron/push' limit 1$q$ into base;
  if base is null then
    execute $q$select substring(command from '(https://[A-Za-z0-9.:-]+)/api/cron/(hourly|push|sync)') from cron.job
      where command ~ '/api/cron/(hourly|push|sync)' limit 1$q$ into base;
  end if;
  base := coalesce(base, 'https://kicksma.sh');

  -- 2. Another job that calls the push route would call it with no gate: it goes, as in 0069.
  for job in execute $q$select jobid, jobname from cron.job
    where command ~ '/api/cron/push' and (jobname is null or jobname <> 'kicksmash-push')$q$ loop
    raise notice 'replacing job % (%)', job.jobid, coalesce(job.jobname, 'no name');
    execute 'select cron.unschedule($1::bigint)' using job.jobid;
  end loop;

  -- 3. The push job, every five minutes, with the gate. cron.schedule replaces a job of the same name.
  execute 'select cron.schedule($1, $2, $3)' using 'kicksmash-push', '*/5 * * * *', format(
    $c$with due as (select public.kicksmash_push_due() as yes), tick as (insert into public.metrics_daily (day, key, value) select (now() at time zone 'UTC')::date, k, floor(extract(epoch from now()))::bigint from due, unnest(array['cron_push_tick_at', 'cron_push_called_at']) as k where k = 'cron_push_tick_at' or due.yes on conflict (day, key) do update set value = excluded.value) select net.http_get(url := %L, headers := jsonb_build_object('Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'kicksmash_cron_secret')), timeout_milliseconds := 60000) from due where due.yes$c$,
    base || '/api/cron/push');
end
$migration$;
