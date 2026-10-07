import express from 'express';
import cron from 'node-cron';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import crypto from 'crypto';

dotenv.config();
const app=express();
const PORT=process.env.PORT||3000;
const DB='./data/jobs.json';
const profile={name:'Mohit Varshney',experience:2.5,roles:['.NET','C#','ASP.NET Core','ASP.NET MVC','Backend','Software Engineer','Full Stack'],skills:['SQL Server','EF Core','Dapper','REST APIs','Azure','Azure Service Bus','RabbitMQ','TeamCity','Octopus Deploy'],minLpa:10,maxLpa:25,work:['remote','hybrid','office'],office:['noida','gurgaon'],exclude:['coforge','intern','internship']};
app.use(express.json()); app.use(express.static('public'));
async function readDB(){try{return JSON.parse(await fs.readFile(DB,'utf8'));}catch{return {jobs:[],applications:[],lastScan:null};}}
async function writeDB(x){await fs.writeFile(DB,JSON.stringify(x,null,2));}
function auth(req,res,next){const token=req.headers['x-admin-token']||req.query.token;if(process.env.ADMIN_TOKEN&&token!==process.env.ADMIN_TOKEN)return res.status(401).json({error:'Unauthorized'});next();}
function score(j){const s=(j.title+' '+j.description+' '+j.company+' '+j.location).toLowerCase();let n=0;for(const x of profile.skills)if(s.includes(x.toLowerCase()))n+=8;for(const x of profile.roles)if(s.includes(x.toLowerCase()))n+=7;if(/remote/.test(s))n+=12;if(/noida|gurgaon|gurugram/.test(s))n+=10;for(const x of profile.exclude)if(s.includes(x))n-=30;return Math.max(0,Math.min(99,n));}
async function fetchJobs(){
 const urls=[
  'https://remotive.com/api/remote-jobs?search=.net',
  'https://remotive.com/api/remote-jobs?search=c%23',
  'https://remotive.com/api/remote-jobs?search=asp.net'
 ];
 const out=[];for(const u of urls){try{const r=await fetch(u);if(!r.ok)continue;const d=await r.json();for(const j of (d.jobs||[])){out.push({id:'remotive-'+j.id,title:j.title,company:j.company_name,location:j.candidate_required_location||'Remote',description:(j.description||'').replace(/<[^>]*>/g,' ').slice(0,3000),url:j.url,source:'Remotive',posted:j.publication_date});}}catch{}}
 return out;
}
async function scan(){const db=await readDB();const incoming=await fetchJobs();const seen=new Set(db.jobs.map(x=>x.id));for(const j of incoming){if(seen.has(j.id))continue;j.score=score(j);j.status=j.score>=55?'shortlisted':'new';db.jobs.push(j);}db.jobs.sort((a,b)=>b.score-a.score);db.jobs=db.jobs.slice(0,1000);db.lastScan=new Date().toISOString();await writeDB(db);return {added:incoming.filter(j=>!seen.has(j.id)).length,total:db.jobs.length};}
app.get('/api/profile',(req,res)=>res.json(profile));
app.get('/api/dashboard',auth,async(req,res)=>{const d=await readDB();res.json({profile,stats:{matches:d.jobs.filter(j=>j.score>=55).length,shortlisted:d.jobs.filter(j=>j.status==='shortlisted').length,applications:d.applications.length,interviews:d.applications.filter(x=>x.status==='interview').length},lastScan:d.lastScan,jobs:d.jobs.slice(0,50),applications:d.applications});});
app.post('/api/scan',auth,async(req,res)=>res.json(await scan()));
app.post('/api/applications',auth,async(req,res)=>{const {jobId}=req.body;const d=await readDB();const job=d.jobs.find(j=>j.id===jobId);if(!job)return res.status(404).json({error:'Job not found'});if(d.applications.some(x=>x.jobId===jobId))return res.json({ok:true,message:'Already tracked'});d.applications.push({id:crypto.randomUUID(),jobId,company:job.company,title:job.title,url:job.url,status:'approved',createdAt:new Date().toISOString()});await writeDB(d);res.json({ok:true,url:job.url});});
app.post('/api/applications/:id/status',auth,async(req,res)=>{const d=await readDB();const x=d.applications.find(a=>a.id===req.params.id);if(!x)return res.status(404).json({error:'Not found'});x.status=req.body.status||x.status;await writeDB(d);res.json(x);});
cron.schedule(process.env.SCAN_CRON||'0 */3 * * *',()=>scan().catch(()=>{}));
app.listen(PORT,()=>console.log(`Mohit portal running on ${PORT}`));
