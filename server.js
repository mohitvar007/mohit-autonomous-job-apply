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
  return { jobs: [], applications: [], lastScan: null };
}

async function readDB() {
  if (pool) {
    await ensureDatabase();
    const result = await pool.query(
      'SELECT data FROM portal_state WHERE id = 1'
    );
    return result.rows[0]?.data || emptyDB();
  }

  try {
    return JSON.parse(await fs.readFile(DB, 'utf8'));
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
  const text = (
    job.title + ' ' + job.description + ' ' +
    job.company + ' ' + job.location
  ).toLowerCase();

  let result = 0;

  for (const skill of profile.skills) {
    if (text.includes(skill.toLowerCase())) result += 8;
  }

  for (const role of profile.roles) {
    if (text.includes(role.toLowerCase())) result += 7;
  }

  if (/remote/.test(text)) result += 12;
  if (/noida|gurgaon|gurugram/.test(text)) result += 10;

  for (const excluded of profile.exclude) {
    if (text.includes(excluded)) result -= 30;
  }

  return Math.max(0, Math.min(99, result));
}

async function fetchJobs() {
  // One request per scan. Remotive advises fetching its public feed only a
  // few times daily; local scoring filters the returned remote roles.
  const url = 'https://remotive.com/api/remote-jobs';
  const response = await fetch(url, {
    headers: { 'User-Agent': 'MohitJobPortal/1.1 (personal job search)' },
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error('Job source returned HTTP ' + response.status);
  }

  const data = await response.json();
  return (data.jobs || []).map(job => ({
    id: 'remotive-' + job.id,
    title: job.title || '',
    company: job.company_name || '',
    location: job.candidate_required_location || 'Remote',
    description: (job.description || '')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 3000),
    url: job.url,
    source: 'Remotive',
    posted: job.publication_date
  }));
}

async function scan() {
  const db = await readDB();
  const incoming = await fetchJobs();
  const seen = new Set(db.jobs.map(job => job.id));
  let added = 0;

  for (const job of incoming) {
    if (seen.has(job.id)) continue;

    job.score = score(job);
    job.status = job.score >= 55 ? 'shortlisted' : 'new';
    db.jobs.push(job);
    seen.add(job.id);
    added++;
  }

  db.jobs.sort((a, b) => b.score - a.score);
  db.jobs = db.jobs.slice(0, 1000);
  db.lastScan = new Date().toISOString();

  await writeDB(db);
  return { added, total: db.jobs.length, lastScan: db.lastScan };
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
      jobs: db.jobs.slice(0, 50),
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
    const minIntervalHours = Number(process.env.MIN_SCAN_INTERVAL_HOURS || 6);
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

const schedule = process.env.SCAN_CRON || '0 8,20 * * *';
cron.schedule(schedule, () => {
  scan().then(result => {
    console.log('Scheduled scan complete:', result);
  }).catch(error => {
    console.error('Scheduled scan failed:', error.message);
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Mohit portal running on port ${PORT}`);
});
