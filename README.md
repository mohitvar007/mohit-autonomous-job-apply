# CareerDesk — Personal Job Search Workspace

A private, supervised job-discovery and application-tracking workspace built with Node.js, Express, PostgreSQL, and a responsive browser dashboard.

## What it does

- Discovers remote software roles from the Remotive public jobs feed.
- Optionally aggregates Google Jobs results through SerpApi and India listings through Adzuna when API credentials are configured.
- Provides one-click search links to LinkedIn, Naukri, Indeed, and Google Jobs; these links are not represented as direct data integrations.
- Scores listings against a configured .NET/C# backend profile using transparent keyword heuristics.
- Deduplicates listings and persists the job list and application tracker in PostgreSQL when `DATABASE_URL` is configured.
- Provides a dashboard for search, score and location filtering, review, and application status tracking.
- Protects dashboard data and write endpoints with an admin token.
- Exposes `/healthz` for basic service and storage-mode checks.
- Supports twice-daily GitHub Actions scans, with a manual workflow trigger for troubleshooting.

## Honest limitations

- **No automatic final submissions.** Tracking a role saves it to the portal and opens the employer's page; you complete and submit the application yourself.
- **Heuristic scoring, not an AI model.** Scores are keyword-based indicators, not probabilities or guarantees of fit.
- **Source coverage depends on configuration.** Remotive is enabled by default. Google Jobs aggregation requires `SERPAPI_API_KEY`; Adzuna India requires `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`. Without these secrets, the portal only fetches from Remotive. These aggregators do not guarantee every LinkedIn, Naukri, or Indeed listing.
- **Direct job-board integrations are not enabled.** LinkedIn and Indeed APIs are permissioned/partner-oriented rather than general public job-search APIs. The portal therefore provides direct search shortcuts instead of pretending to fetch those sites directly. See [LinkedIn API access](https://www.linkedin.com/help/linkedin/answer/a526048) and [Indeed Partner Docs](https://docs.indeed.com/).
- **Salary is a preference, not a verified hard filter.** Verify compensation, location, seniority, and eligibility on the employer's listing.
- **Feed limits matter.** The workflow runs twice daily, while the portal enforces a configurable cooldown. A scheduled run that receives HTTP 429 is reported as a skipped scan instead of a misleading workflow failure.
- **Hosting and database tiers have provider-specific limits.** Check the current Render and database-provider plans, retention, backups, and usage limits. Do not assume a free tier is permanent.
- This app does not call paid OpenAI or Claude APIs. A ChatGPT subscription does not itself provide an API key.

## Deployment

### Render web service

- Build command: `npm install`
- Start command: `npm start`
- `ADMIN_TOKEN`: long, unique secret; never commit it to source control.
- `DATABASE_URL`: PostgreSQL connection string for persistent hosted storage.
- `MIN_SCAN_INTERVAL_HOURS`: normally `12`.
- `ENABLE_IN_PROCESS_CRON`: `false` when GitHub Actions owns the schedule, to avoid duplicate schedulers.
- `SERPAPI_API_KEY`: optional key for Google Jobs aggregation.
- `ADZUNA_APP_ID` and `ADZUNA_APP_KEY`: optional Adzuna India API credentials.

After deployment, open `/healthz`. Expected output when PostgreSQL is configured:

```json
{"ok":true,"storage":"postgres"}
```

The dashboard requires the configured admin token. It is entered in the browser and stored in session storage for that tab.

### GitHub Actions scheduled scans

The workflow `.github/workflows/scan-jobs.yml` runs at 08:00 and 20:00 UTC and supports manual dispatch.

Create these repository Actions secrets:

- `PORTAL_URL`: the HTTPS base URL of the intended Render service, without a trailing slash.
- `PORTAL_ADMIN_TOKEN`: the same secret value as Render's `ADMIN_TOKEN`.

The workflow checks configuration, serializes its own runs, reports cooldown HTTP 429 as a skipped scan, and fails on other non-2xx errors. GitHub scheduled workflows can be delayed by GitHub. Confirm a successful or cooldown-skipped run in the Actions tab.

### Release checklist

1. Review the changes on the release branch.
2. Confirm Render is deploying the intended branch and the intended service.
3. Confirm `DATABASE_URL`, `ADMIN_TOKEN`, `MIN_SCAN_INTERVAL_HOURS`, and `ENABLE_IN_PROCESS_CRON` are correct.
4. Check `/healthz`, then connect to the dashboard and verify jobs and applications load.
5. Trigger the GitHub Actions workflow and inspect its result.
6. Test tracking a job and updating its status; verify that no employer submission occurs automatically.
7. Rotate any admin token that may have been exposed, and update both Render and GitHub Actions secrets together.

## Local development

1. Install a current Node.js LTS release.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and configure `ADMIN_TOKEN`.
4. Run `npm start` and open `http://localhost:3000`.

For local-only scheduled scans, set `ENABLE_IN_PROCESS_CRON=true`. Do not enable it on the hosted service while GitHub Actions is scheduling scans.
