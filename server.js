import express from 'express';
import cron from 'node-cron';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import crypto from 'crypto';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB = './jobs.json';

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

app.use(express.json());

/* Serve the website from the repository root */
app.get('/', (req, res) => {
  res.sendFile(path.join(process.cwd(), 'index.html'));
});

async function readDB() {
  try {
    return JSON.parse(await fs.readFile(DB, 'utf8'));
  } catch {
    return {
      jobs: [],
      applications: [],
      lastScan: null
    };
  }
}

async function writeDB(data) {
  await fs.writeFile(DB, JSON.stringify(data, null, 2));
}

function auth(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;

  if (
    process.env.ADMIN_TOKEN &&
    token !== process.env.ADMIN_TOKEN
  ) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }

  next();
}

function score(job) {
  const text = (
    job.title +
    ' ' +
    job.description +
    ' ' +
    job.company +
    ' ' +
    job.location
  ).toLowerCase();

  let score = 0;

  for (const skill of profile.skills) {
    if (text.includes(skill.toLowerCase())) {
      score += 8;
    }
  }

  for (const role of profile.roles) {
    if (text.includes(role.toLowerCase())) {
      score += 7;
    }
  }

  if (/remote/.test(text)) {
    score += 12;
  }

  if (/noida|gurgaon|gurugram/.test(text)) {
    score += 10;
  }

  for (const excluded of profile.exclude) {
    if (text.includes(excluded)) {
      score -= 30;
    }
  }

  return Math.max(0, Math.min(99, score));
}

async function fetchJobs() {
  const urls = [
    'https://remotive.com/api/remote-jobs?search=.net',
    'https://remotive.com/api/remote-jobs?search=c%23',
    'https://remotive.com/api/remote-jobs?search=asp.net'
  ];

  const jobs = [];

  for (const url of urls) {
    try {
      const response = await fetch(url);

      if (!response.ok) {
        continue;
      }

      const data = await response.json();

      for (const job of data.jobs || []) {
        jobs.push({
          id: 'remotive-' + job.id,
          title: job.title,
          company: job.company_name,
          location:
            job.candidate_required_location || 'Remote',
          description: (job.description || '')
            .replace(/<[^>]*>/g, ' ')
            .slice(0, 3000),
          url: job.url,
          source: 'Remotive',
          posted: job.publication_date
        });
      }
    } catch (error) {
      console.error('Job source error:', error.message);
    }
  }

  return jobs;
}

async function scan() {
  const db = await readDB();
  const incoming = await fetchJobs();

  const seen = new Set(
    db.jobs.map(job => job.id)
  );

  for (const job of incoming) {
    if (seen.has(job.id)) {
      continue;
    }

    job.score = score(job);
    job.status =
      job.score >= 55
        ? 'shortlisted'
        : 'new';

    db.jobs.push(job);
  }

  db.jobs.sort(
    (a, b) => b.score - a.score
  );

  db.jobs = db.jobs.slice(0, 1000);

  db.lastScan = new Date().toISOString();

  await writeDB(db);

  return {
    added: incoming.filter(
      job => !seen.has(job.id)
    ).length,
    total: db.jobs.length
  };
}

app.get('/api/profile', (req, res) => {
  res.json(profile);
});

app.get(
  '/api/dashboard',
  auth,
  async (req, res) => {
    const db = await readDB();

    res.json({
      profile,
      stats: {
        matches: db.jobs.filter(
          job => job.score >= 55
        ).length,

        shortlisted: db.jobs.filter(
          job => job.status === 'shortlisted'
        ).length,

        applications:
          db.applications.length,

        interviews:
          db.applications.filter(
            application =>
              application.status === 'interview'
          ).length
      },

      lastScan: db.lastScan,

      jobs: db.jobs.slice(0, 50),

      applications:
        db.applications
    });
  }
);

app.post(
  '/api/scan',
  auth,
  async (req, res) => {
    try {
      const result = await scan();
      res.json(result);
    } catch (error) {
      res.status(500).json({
        error: error.message
      });
    }
  }
);

app.post(
  '/api/applications',
  auth,
  async (req, res) => {
    const { jobId } = req.body;

    const db = await readDB();

    const job = db.jobs.find(
      item => item.id === jobId
    );

    if (!job) {
      return res.status(404).json({
        error: 'Job not found'
      });
    }

    if (
      db.applications.some(
        application =>
          application.jobId === jobId
      )
    ) {
      return res.json({
        ok: true,
        message: 'Already tracked'
      });
    }

    db.applications.push({
      id: crypto.randomUUID(),
      jobId,
      company: job.company,
      title: job.title,
      url: job.url,
      status: 'approved',
      createdAt:
        new Date().toISOString()
    });

    await writeDB(db);

    res.json({
      ok: true,
      url: job.url
    });
  }
);

app.post(
  '/api/applications/:id/status',
  auth,
  async (req, res) => {
    const db = await readDB();

    const application =
      db.applications.find(
        item =>
          item.id === req.params.id
      );

    if (!application) {
      return res.status(404).json({
        error: 'Application not found'
      });
    }

    application.status =
      req.body.status ||
      application.status;

    await writeDB(db);

    res.json(application);
  }
);

cron.schedule(
  process.env.SCAN_CRON ||
    '0 */3 * * *',
  () => {
    scan().catch(error =>
      console.error(
        'Scheduled scan failed:',
        error.message
      )
    );
  }
);

app.listen(PORT, () => {
  console.log(
    `Mohit portal running on port ${PORT}`
  );
});
