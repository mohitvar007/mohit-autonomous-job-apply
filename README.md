# Mohit's Autonomous Job Apply Portal

A Node.js / Express job-search dashboard configured for Mohit's .NET profile. The website can be hosted on Render and opened from any device using its public HTTPS URL.

## Features

- Remote-job discovery through Remotive's public API
- Profile-based keyword scoring and duplicate filtering
- Shortlist dashboard and application tracking
- Manual scan with a 12-hour default cooldown
- Optional PostgreSQL storage via `DATABASE_URL`
- Admin token protection for dashboard and write endpoints
- Health endpoint at `/healthz`
- Optional scheduled scans through GitHub Actions (free for eligible GitHub usage)

## Important limitations

- This is a supervised job-search tool, not an automatic final-submission bot. It opens the employer's application page after you choose a role.
- The Remotive public API advises no more than four requests per day. The included workflow schedules two scans per day; avoid repeated manual scans.
- Remotive's public feed focuses on remote jobs. It does not guarantee discovery of every hybrid or office role in Noida/Gurgaon.
- A free Render web service sleeps after 15 minutes without incoming traffic, and its local filesystem is ephemeral. Your site remains reachable, but the first request after sleep may take around a minute and local JSON data may be lost after a restart/redeploy. See Render's current free-tier limitations: https://render.com/docs/free
- Render's free Postgres database currently expires after 30 days. If you need data to persist beyond that, configure a suitable external free Postgres provider and monitor that provider's limits and terms. Do not assume a free tier is permanent.
- The local JSON file is intended only for local development. Configure `DATABASE_URL` for hosted data you need to retain.
- ChatGPT Go does not provide an OpenAI API key or unlimited API access. This version does not call paid Claude/OpenAI APIs.

## Deploy on Render

1. Push or merge this branch only after reviewing it. Do not change the currently deployed branch until you're ready.
2. In Render, open your existing Web Service and set its branch to the branch you intend to deploy, or create a separate preview service if you want to test without touching production.
3. Build command: `npm install`; start command: `npm start`.
4. Add these environment variables in Render:
   - `ADMIN_TOKEN`: a long random secret (never commit it to GitHub).
   - `DATABASE_URL`: connection string from a free Postgres provider if you want hosted data to survive restarts.
   - `MIN_SCAN_INTERVAL_HOURS`: `12` (default).
   - `ENABLE_IN_PROCESS_CRON`: `false` (default; GitHub Actions runs the hosted schedule).
5. Deploy and open `https://YOUR-SERVICE.onrender.com/healthz`. It should return `{"ok":true,"storage":"postgres"}` if a database is configured.
6. Open the main URL and click **Admin access**, then enter the exact `ADMIN_TOKEN` you configured.

## Configure free scheduled scans using GitHub Actions

The workflow at `.github/workflows/scan-jobs.yml` runs at 08:00 and 20:00 UTC and can also be triggered manually.

In the repository, open **Settings → Secrets and variables → Actions → New repository secret** and add:

- `PORTAL_URL`: the base Render URL, e.g. `https://your-service.onrender.com` (no trailing slash).
- `PORTAL_ADMIN_TOKEN`: the same value as Render's `ADMIN_TOKEN`.

Do not put the secret in source code or workflow files. GitHub's scheduled workflows can be delayed, and availability/usage limits depend on your GitHub account. After setting secrets, open the **Actions** tab and run the workflow once manually to test it.

## Local development

1. Install a current Node.js LTS release.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set `ADMIN_TOKEN`.
4. Run `npm start`.
5. Open `http://localhost:3000`.

For local in-process scheduling, set `ENABLE_IN_PROCESS_CRON=true`. Do not enable it on the hosted service while GitHub Actions is also scheduling scans.
