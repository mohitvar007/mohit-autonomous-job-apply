import express from 'express';
import cron from 'node-cron';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';
import pg from 'pg';

dotenv.config();

const { Pool } = pg;
const app = express();
const PORT = process.env.PORT || 3000;
const DB = path.join(process.cwd(), 'jobs.json');
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : null;
let dbInitPromise;

const profile = {
  name: 'Mohit Varshney',
  experience: 2.5,
  roles: [
    '.NET',
    'C#',
    'ASP.NET Core',
    'ASP.NET MVC',
    'Backend',
    'Software Engineer',
    'Full Stack'
  ],
  skills: [
    'SQL Server',
    'EF Core',
    'Dapper',
    'REST APIs',
    'Azure',
    'Azure Service Bus',
    'RabbitMQ',
    'TeamCity',
    'Octopus Deploy'
  ],
  minLpa: 10,
  maxLpa: 25,
  work: ['remote', 'hybrid', 'office'],
  office: ['noida', 'gurgaon'],
  exclude: ['coforge', 'intern', 'internship']
};

app.use(express.json({ limit: '100kb' }));

app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    storage: pool ? 'postgres' : 'local-json'
  });
});

async function ensureDatabase() {
  if (!pool) return;
  if (!dbInitPromise) {
    dbInitPromise = pool.query(`
      CREATE TABLE IF NOT EXISTS portal_state (
        id INTEGER PRIMARY KEY,
        data JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
  }
  await dbInitPromise;
}

function emptyDB() {
  return { jobs: [], applications: [], lastScan: null, lastScanSources: [] };
}

function refreshScores(data) {
  // Re-score previously stored jobs whenever the dashboard is loaded so
  // improvements to matching logic also apply to existing listings.
  for (const job of data.jobs || []) {
    job.score = score(job);
    if (job.status === 'shortlisted' || job.status === 'new') {
      job.status = job.score >= 55 ? 'shortlisted' : 'new';
    }
  }
  return data;
}

async function readDB() {
  if (pool) {
    await ensureDatabase();
    const result = await pool.query(
      'SELECT data FROM portal_state WHERE id = 1'
    );
    return refreshScores(result.rows[0]?.data || emptyDB());
  }

  try {
    return refreshScores(JSON.parse(await fs.readFile(DB, 'utf8')));
  } catch {
    return emptyDB();
  }
}

async function writeDB(data) {
  if (pool) {
    await ensureDatabase();
    await pool.query(
      `INSERT INTO portal_state (id, data, updated_at)
       VALUES (1, $1::jsonb, NOW())
       ON CONFLICT (id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
      [JSON.stringify(data)]
    );
    return;
  }

  await fs.writeFile(DB, JSON.stringify(data, null, 2));
}

function auth(req, res, next) {
  const expected = process.env.ADMIN_TOKEN;
  const token = req.headers['x-admin-token'] || req.query.token;

  // Fail closed: never expose dashboard or mutation endpoints if the secret
  // has not been configured in the hosting environment.
  if (!expected) {
    return res.status(503).json({
      error: 'Admin access is not configured. Set ADMIN_TOKEN in the hosting environment.'
    });
  }

  if (token !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  next();
}

function score(job) {
  const title = String(job.title || '').toLowerCase();
  const text = (
    title + ' ' + job.description + ' ' +
    job.company + ' ' + job.location
  ).toLowerCase();

  let result = 0;

  // Prioritise the candidate's actual .NET/C# stack rather than generic
  // mentions of "developer" or "full stack" in unrelated job descriptions.
  if (/\.net|dotnet|c#|asp\.net/.test(title)) result += 32;
  if (/backend|back-end|back end/.test(title)) result += 16;
  if (/software engineer|software developer/.test(title)) result += 8;
  if (/full[ -]?stack/.test(title)) result += 5;

  for (const skill of profile.skills) {
    if (text.includes(skill.toLowerCase())) result += 5;
  }

  if (/remote/.test(String(job.location || '').toLowerCase())) result += 4;
  if (/noida|gurgaon|gurugram/.test(String(job.location || '').toLowerCase())) result += 12;

  for (const excluded of profile.exclude) {
    if (text.includes(excluded)) result -= 30;
  }

  return Math.max(0, Math.min(99, result));
}

async function fetchJobs() {
  const results = await Promise.allSettled([
    fetchRemotiveJobs(),
    fetchSerpApiJobs(),
    fetchAdzunaJobs()
  ]);
  const jobs = [];
  const sourceErrors = [];
  for (const result of results) {
    if (result.status === 'fulfilled') jobs.push(...result.value);
    else {
      sourceErrors.push(result.reason?.message || 'Unknown source error');
      console.warn('Job source unavailable:', result.reason?.message || result.reason);
    }
  }
  if (!jobs.length) {
    throw new Error('All job sources failed. Check configured source credentials and provider status.');
  }
  console.log('Job discovery sources:', JSON.stringify({
    fetched: jobs.length,
    sources: [...new Set(jobs.map(job => job.source))],
    failedSources: sourceErrors.length
  }));
  return jobs;
}

function normalizeJob({ id, title, company, location, description, url, source, posted }) {
  if (!title || !url) return null;
  return {
    id: String(id),
    title: String(title).trim(),
    company: String(company || 'Company not listed').trim(),
    location: String(location || 'Location not specified').trim(),
    description: String(description || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 3000),
    url: String(url),
    source: String(source || 'Job board'),
    posted: posted || null
  };
}

async function fetchJson(url, label) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'CareerDesk/2.0 (personal job search)' },
    signal: AbortSignal.timeout(18000)
  });
  if (!response.ok) throw new Error(label + ' returned HTTP ' + response.status);
  return response.json();
}

async function fetchRemotiveJobs() {
  const data = await fetchJson('https://remotive.com/api/remote-jobs', 'Remotive');
  return (data.jobs || []).map(job => normalizeJob({
    id: 'remotive-' + job.id,
    title: job.title,
    company: job.company_name,
    location: job.candidate_required_location || 'Remote',
    description: job.description,
    url: job.url,
    source: 'Remotive',
    posted: job.publication_date
  })).filter(Boolean);
}

async function fetchSerpApiJobs() {
  if (!process.env.SERPAPI_API_KEY) return [];
  const searches = [
    { query: '.NET developer C# ASP.NET Core', location: 'Noida, Uttar Pradesh, India' },
    { query: '.NET developer C# ASP.NET Core', location: 'Gurugram, Haryana, India' },
    { query: '.NET developer C# ASP.NET Core remote', location: 'India' }
  ];
  const results = await Promise.allSettled(searches.map(async search => {
    const params = new URLSearchParams({
      engine: 'google_jobs',
      q: search.query,
      location: search.location,
      hl: 'en',
      gl: 'in',
      api_key: process.env.SERPAPI_API_KEY
    });
    const data = await fetchJson('https://serpapi.com/search.json?' + params, 'Google Jobs (SerpApi)');
    return (data.jobs_results || []).flatMap(job => {
      const apply = Array.isArray(job.apply_options) ? job.apply_options.find(option => option.link)?.link : '';
      const url = apply || job.share_link;
      const via = job.via ? String(job.via).replace(/^via\s+/i, '') : 'Google Jobs';
      const normalized = normalizeJob({
        id: 'googlejobs-' + (job.job_id || crypto.createHash('sha1').update([job.title, job.company_name, job.location, url].join('|')).digest('hex')),
        title: job.title,
        company: job.company_name,
        location: job.location,
        description: job.description,
        url,
        source: 'Google Jobs · ' + via,
        posted: job.detected_extensions?.posted_at || null
      });
      return normalized ? [normalized] : [];
    });
  }));
  return results.flatMap(result => {
    if (result.status === 'fulfilled') return result.value;
    console.warn('Google Jobs query failed:', result.reason?.message || result.reason);
    return [];
  });
}

async function fetchAdzunaJobs() {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) return [];
  const params = new URLSearchParams({
    app_id: appId,
    app_key: appKey,
    results_per_page: '50',
    what: '.NET C# ASP.NET Core developer',
    where: 'India',
    'content-type': 'application/json'
  });
  const data = await fetchJson('https://api.adzuna.com/v1/api/jobs/in/search/1?' + params, 'Adzuna India');
  return (data.results || []).map(job => normalizeJob({
    id: 'adzuna-' + job.id,
    title: job.title,
    company: job.company?.display_name,
    location: job.location?.display_name,
    description: job.description,
    url: job.redirect_url,
    source: 'Adzuna',
    posted: job.created
  })).filter(Boolean);
}

async function scan() {
  const db = await readDB();
  const incoming = await fetchJobs();
  const fingerprint = job => String(job.url || '').toLowerCase().split('?')[0]
    || [job.title, job.company, job.location].map(value => String(value || '').toLowerCase().trim()).join('|');
  const seenIds = new Set(db.jobs.map(job => job.id));
  const seenFingerprints = new Set(db.jobs.map(fingerprint));
  let added = 0;

  for (const job of incoming) {
    const key = fingerprint(job);
    if (seenIds.has(job.id) || seenFingerprints.has(key)) continue;

    job.score = score(job);
    job.status = job.score >= 55 ? 'shortlisted' : 'new';
    db.jobs.push(job);
    seenIds.add(job.id);
    seenFingerprints.add(key);
    added++;
  }

  db.jobs.sort((a, b) => b.score - a.score);
  db.jobs = db.jobs.slice(0, 1000);
  db.lastScan = new Date().toISOString();
  db.lastScanSources = [...new Set(incoming.map(job => job.source))];

  await writeDB(db);
  return { added, total: db.jobs.length, lastScan: db.lastScan, sources: db.lastScanSources };
}

app.get('/api/profile', (req, res) => {
  res.json(profile);
});

app.get('/api/dashboard', auth, async (req, res) => {
  try {
    const db = await readDB();
    res.json({
      profile,
      stats: {
        matches: db.jobs.filter(job => job.score >= 55).length,
        shortlisted: db.jobs.filter(job => job.status === 'shortlisted').length,
        applications: db.applications.length,
        interviews: db.applications.filter(
          application => application.status === 'interview'
        ).length
      },
      lastScan: db.lastScan,
      sources: [...new Set((db.jobs || []).map(job => job.source).filter(Boolean))],
      configuredSources: {
        remotive: true,
        googleJobs: Boolean(process.env.SERPAPI_API_KEY),
        adzuna: Boolean(process.env.ADZUNA_APP_ID && process.env.ADZUNA_APP_KEY)
      },
      jobs: db.jobs.slice(0, 100),
      applications: db.applications
    });
  } catch (error) {
    console.error('Dashboard load failed:', error.message);
    res.status(500).json({ error: 'Could not load portal data. Check database configuration.' });
  }
});

app.post('/api/scan', auth, async (req, res) => {
  try {
    const db = await readDB();
    const minIntervalHours = Number(process.env.MIN_SCAN_INTERVAL_HOURS || 12);
    if (db.lastScan) {
      const elapsedMs = Date.now() - new Date(db.lastScan).getTime();
      const minimumMs = minIntervalHours * 60 * 60 * 1000;
      if (Number.isFinite(elapsedMs) && elapsedMs >= 0 && elapsedMs < minimumMs) {
        const retryAfterSeconds = Math.ceil((minimumMs - elapsedMs) / 1000);
        return res.status(429).json({
          error: 'A scan ran recently. Please wait before requesting another scan.',
          retryAfterSeconds
        });
      }
    }

    const result = await scan();
    res.json(result);
  } catch (error) {
    console.error('Manual scan failed:', error.message);
    res.status(500).json({ error: 'Scan failed. Please try again later.' });
  }
});

app.post('/api/applications', auth, async (req, res) => {
  const { jobId } = req.body || {};
  if (typeof jobId !== 'string' || !jobId) {
    return res.status(400).json({ error: 'A valid jobId is required.' });
  }

  try {
    const db = await readDB();
    const job = db.jobs.find(item => item.id === jobId);

    if (!job) return res.status(404).json({ error: 'Job not found' });

    if (db.applications.some(application => application.jobId === jobId)) {
      return res.json({ ok: true, message: 'Already tracked' });
    }

    db.applications.push({
      id: crypto.randomUUID(),
      jobId,
      company: job.company,
      title: job.title,
      url: job.url,
      status: 'approved',
      createdAt: new Date().toISOString()
    });

    await writeDB(db);
    res.json({ ok: true, url: job.url });
  } catch (error) {
    console.error('Application tracking failed:', error.message);
    res.status(500).json({ error: 'Could not save application tracking data.' });
  }
});

app.post('/api/applications/:id/status', auth, async (req, res) => {
  const allowedStatuses = new Set([
    'approved', 'applied', 'assessment', 'interview',
    'offer', 'rejected', 'withdrawn'
  ]);
  const status = req.body?.status;

  if (!allowedStatuses.has(status)) {
    return res.status(400).json({ error: 'Invalid application status.' });
  }

  try {
    const db = await readDB();
    const application = db.applications.find(item => item.id === req.params.id);

    if (!application) {
      return res.status(404).json({ error: 'Application not found' });
    }

    application.status = status;
    await writeDB(db);
    res.json(application);
  } catch (error) {
    console.error('Application status update failed:', error.message);
    res.status(500).json({ error: 'Could not update application status.' });
  }
});

// Hosted free-tier scheduling is handled by GitHub Actions so scans can run
// even after Render spins down the web service. Enable this only for local
// or always-on hosting to avoid duplicate scheduled requests.
if (process.env.ENABLE_IN_PROCESS_CRON === 'true') {
  const schedule = process.env.SCAN_CRON || '0 8,20 * * *';
  cron.schedule(schedule, () => {
    scan().then(result => {
      console.log('Scheduled scan complete:', result);
    }).catch(error => {
      console.error('Scheduled scan failed:', error.message);
    });
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mohit portal running on port ${PORT}`);
});
