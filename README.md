# Mohit's Autonomous Job Apply Portal

A self-hostable Node/Express job-search dashboard configured for Mohit's .NET profile.

## What this version does
- Hosted web dashboard
- Automatic server-side scan every 3 hours
- Remote-job discovery through public Remotive API searches
- Resume/profile-based scoring
- Duplicate filtering
- Shortlist dashboard
- Approve & open application link
- Application tracking
- No passwords or job-board credentials stored

## Important
This is deliberately not a CAPTCHA/OTP bypass bot. Final submission on a job board is only automated where the site/API explicitly permits it. The current connector opens the source application page after approval.

## Deploy on Render from a phone
1. Create a GitHub repository and upload all files/folders in this project.
2. Open Render in your phone browser and create a **Web Service** from that GitHub repo.
3. Runtime: Node. Build command: `npm install`. Start command: `npm start`.
4. Add environment variable `ADMIN_TOKEN` with a long random value.
5. Add `SCAN_CRON=0 */3 * * *`.
6. Deploy. Open the generated `onrender.com` URL.
7. Enter the same ADMIN_TOKEN when prompted.

For production persistence, connect a managed database (Postgres/Supabase) or attach persistent storage. The included JSON store is suitable for an initial personal deployment, not high-scale production.
