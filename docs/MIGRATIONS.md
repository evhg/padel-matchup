# How a database change reaches production

A migration is one file of SQL that adds a column or a table. Since 22 September 2026 it reaches
production through GitHub: the **Migrate** workflow (`.github/workflows/migrate.yml`) applies it when
it reaches `main`, and nobody types SQL. Before that, Claude typed each one into Supabase during a
session. This page says how the move was made, why, and what to do when a run fails.

**Where this stands.** Done. Step 4 below records the seven runs it took to prove it.

## Why move it

Three reasons, in order of weight.

1. **The credential moves to one place you control.** A session used to hold a Supabase password and
   a role that owns every table. Now the database address lives in your repository's settings, and no
   session needs it.
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
4. A panel opens with several tabs: Framework, Server, **Direct**, ORM and MCP. Click **Direct**.
   Inside it, choose **Session pooler**.
5. Click the copy icon. Copy what the panel shows you. Do not type the example below.
   The address looks like
   `postgresql://postgres.udvtuxaxzfimeoubofdz:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres`.

   **Supabase changes this panel from time to time.** Do not trust the tab names. Trust these three
   tests instead. The address you copy must have all of them:

   - the host ends with **`pooler.supabase.com`**
   - the port is **`5432`**, not 6543
   - the user name is **`postgres.udvtuxaxzfimeoubofdz`**, not plain `postgres`
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

   **Paste the address and nothing else.** The box holds the value, not a line of a file. It must
   start with `postgresql://`. These four pastes all fail, and each one has happened:

   - `DIRECT_DATABASE_URL=postgresql://...` — the name of the variable came with it.
   - `psql "postgresql://..."` — that is a command, not an address.
   - `"postgresql://..."` — the quote marks are part of the value.
   - A password with a `#`, a `/`, a `?` or a space in it. Percent-encode those characters.

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

### Step 4 — proved, on 22 September 2026

We proved it with a column that does nothing: `research_runs.migrate_probe`, on a table the site
never reads. Run 7 applied it in 7 seconds. Nobody typed SQL. The migration count went from 62 to
63, and the column was there. A second pull request then removed it the same way.

**It took seven runs, and each failure was worth its cost.** No run before the seventh reached any
SQL, so the database was never at risk.

| Run | What failed | What it proved |
|---|---|---|
| 1 | The script could not start | The workflow starts by itself |
| 2 | No route to the address | The script runs and reaches the database |
| 3 | The same | The new message says the remedy |
| 4 | The database refused the password | The address is right |
| 5 | The same, before the secret changed | — |
| 6 | The secret was not an address at all | The banner catches a bad paste |
| 7 | **Nothing** | **A migration reaches production on its own** |

Every fault is now a check. The gate runs the migration script on every change, so fault 1 cannot
return. Each run prints one line that says where it pointed and who it claimed to be, and describes
a value it cannot read. The password is never in any of those lines.

### If a run says the password is refused

The address is right. Only the password is wrong.

**Do not reset the database password to fix this.** The live site holds the same password in its own
`DATABASE_URL` on Vercel. A reset stops the site until you change that too, and you cannot read the
old value back to compare.

Read the password from your password manager and build the address again. Reset it only if it is
truly lost, and then change `DATABASE_URL` on Vercel in the same sitting.

## What changed afterwards

- **AGENTS.md rules 7 and 10 say the new way.** Production gets each migration from the **Migrate**
  workflow, after the merge. Done.
- **The Supabase password is out of the Claude environment.** Done — you removed it.
- **Claude no longer needs the Supabase connection at all.** Since 23 September, questions go through
  the read-only door `/api/admin/sql` (`docs/OPERATING.md`), so the Supabase MCP is needed for neither
  reading nor migrations. **Setting it to read-only, or removing it, is still open**, and it is yours.

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
