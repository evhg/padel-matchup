# How a database change reaches production

A migration is one file of SQL that adds a column or a table. Today it reaches production because
Claude types it into Supabase during a session. This page says how to move that job to GitHub, and
why you would.

**Where this stands.** The workflow file is built: `.github/workflows/migrate.yml`. It starts by
itself and it runs the right command. Two runs have proved that. Both then failed to reach the
database, because step 1 below named the wrong address. **Step 1 is the one thing left to do.**
Rule 7 still sends migrations through a session until a run turns green.

## Why move it

Three reasons, in order of weight.

1. **The credential moves to one place you control.** Today a session holds a Supabase password and
   a role that owns every table. If the job moves to GitHub, the database address lives in your
   repository's settings, and no session needs it.
2. **It runs by itself.** You approve a migration twice already: once in the conversation where it
   is designed, and once when you merge the pull request that carries it. A third click after the
   merge is ceremony, not safety, so the workflow does not ask for one. Your standing order is that
   one shot means you are not involved until it is finished.
3. **There is a record.** Every run is in the Actions log, with the date, the person and the result.
   A tool call in a chat is not a record anybody can audit later.

## What a "workflow" is

A workflow is a file in the repository that tells GitHub: "when this happens, run these commands on
a fresh computer". The project already has two. One runs the tests on every pull request. One checks
that the site is up.

We added a third. It says: "when a migration reaches `main`, apply it." It does not ask you first.
You already approved the migration when you merged it.

## What you do, step by step

You need about ten minutes, once. You never repeat steps 1 and 2.

### Step 1 — copy the database address from Supabase

1. Open **supabase.com** and sign in.
2. Click the project **evhg's padel-matchup**.
3. At the top right, click the green **Connect** button.
4. A panel opens with several tabs. Choose **Session pooler**. The address ends with **:5432**.
5. Click the copy icon. Copy what the panel shows you. Do not type the example below.
   The address looks like
   `postgresql://postgres.udvtuxaxzfimeoubofdz:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`.
6. Replace `[YOUR-PASSWORD]` with the database password you chose when you made the project. If you
   do not have it, click **Reset database password** on the same panel and save the new one.
7. Keep this address in your password manager. Step 2 is the only place it goes.

**Why the Session pooler.** Supabase offers three addresses. This page told you to copy the wrong
one, and two runs failed on it. Here is what each one is:

| Address | Port | Can GitHub reach it? | Safe for a migration? |
|---|---|---|---|
| Direct connection | 5432 | **No** | Yes |
| **Session pooler** | 5432 | **Yes** | **Yes** |
| Transaction pooler | 6543 | Yes | No |

The direct address has an IPv6 number only. A GitHub computer has no IPv6, so it cannot reach it at
all. Supabase sells an IPv4 add-on that fixes this. It costs money, and you do not need it.

The Session pooler gives each caller its own connection for the length of its work. A migration is
safe on it. The transaction pooler is the one that shares a connection between callers. That is the
one a migration must not use, and it is on a different port.

### Step 2 — give the address to GitHub

You made this secret once already. Now you replace its value.

1. Open **github.com/evhg/padel-matchup**.
2. Click **Settings** in the row of tabs at the top (the one with the gear, on the far right).
3. In the left column, find **Secrets and variables**, and click **Actions** under it.
4. Find `DIRECT_DATABASE_URL` in the list. Click the pencil beside it.
   If it is not there, click the green **New repository secret** and use that name. Use capitals and
   the underscores, exactly as written.
5. Paste the address from step 1 over the old value.
6. Click **Update secret**.
7. Tell Claude. Claude starts the workflow again from the Actions tab.

GitHub hides the value from that moment. Nobody, including you, can read it back. You can only
replace it. That is the point.

### Step 3 — Claude adds the workflow file · **done**

`.github/workflows/migrate.yml`. It says:

- Run only when a migration reaches `main`, or when the two files that apply one change. A copy fix
  does not start it.
- Install the project, then run `pnpm db:migrate`, with `DIRECT_DATABASE_URL` from step 2.
- Give up after five seconds if it cannot take its lock, instead of queueing behind a live query and
  blocking every reader behind it. That is what the by-hand procedure always did.

It also refuses to run twice at once, and it can be started by hand from the Actions tab if a run
failed and you want to try again without a new commit.

`pnpm db:migrate` already exists and is what the project has always used for a fresh database. It
applies each `.sql` file in order and writes its own record of what it applied. It never guesses at
the schema, so it cannot drop the security policies. That is the reason `pnpm db:push` is disabled
and this is not.

### Step 4 — prove it once, with a change that does nothing

Do not make the first run a real migration.

1. Claude opens a pull request that adds a harmless column to a table nobody reads.
2. You merge it.
3. Watch the **Actions** tab. A run called **Migrate** starts by itself, turns green, and its log
   ends with `✓ migrations applied`.
4. Claude checks the column is really there, then opens a second pull request that removes it.

If the run fails, nothing has changed in the database. Read the red step in the log, or send it to
Claude.

**What happened when we tried this.** Run 1 failed because the script itself could not start. The
gate now runs that script on every change, so that cannot happen again. Run 2 failed because this
page named the wrong address, above. Both runs stopped before any SQL, so the database is exactly as
it was. The column from step 4 is still waiting.

## What changes afterwards

- **AGENTS.md rule 7 changes.** It says today that production gets each migration by hand. It would
  say: production gets each migration from the `migrate` workflow, after Cath approves it.
- **Claude stops needing write access to the database.** The Supabase connection can then be set to
  read-only, and Claude keeps only the ability to look at numbers.
- **The Supabase password can come out of the Claude environment.**

## How to undo it

Delete the file `.github/workflows/migrate.yml` from the repository, and delete the
`DIRECT_DATABASE_URL` secret. Migrations then go back to being typed by hand. Nothing in the
database changes either way.

To hold one migration back without undoing anything, keep it out of the pull request. The workflow
starts only when a file in `drizzle/` reaches `main`, so a change that carries no migration file
starts nothing.

## What this does not cover

The workflow applies migrations. It does not deploy the site — Vercel already does that by itself
when `main` moves. The two are separate on purpose: a migration that fails must not take the site
with it.
