# padel-matchup

## Deploying with Vercel

This repo is prepared for Vercel:

- `AGENTS.md` holds Vercel's best practices for coding agents (generated with `vercel agent init`).
- `.claude/settings.json` enables the official Vercel plugin for Claude Code, which adds `/vercel:deploy`, `/vercel:status`, `/vercel:env` and `/vercel:bootstrap`.
- `.gitignore` excludes the `.vercel` link directory and local env files.

One-time link, from a machine or session that can reach vercel.com:

```bash
npm i -g vercel
vercel login
vercel link --repo   # matches this GitHub repo to a Vercel project
vercel git connect   # optional: deploy automatically on git push
```

Once linked, `vercel deploy` creates a preview deployment and `vercel deploy --prod` ships to production. With the Git integration connected, pushes to `main` deploy to production and other branches get preview URLs.
