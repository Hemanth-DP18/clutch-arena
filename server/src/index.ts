import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { checkDatabase, pool } from './db.js';
import apiRoutes, { cleanupCompletedEvents } from './routes.js';

const app = express();
const port = Number(process.env.PORT || 4000);
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS'));
  }
}));
app.use(express.json({ limit: '1mb' }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/api/_healthcheck', (_req, res) => {
  res.json({ status: 'ok', service: 'clutch-arena-api' });
});

app.get('/api/_ready', async (_req, res) => {
  try {
    await checkDatabase();
    res.json({ status: 'ready', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'not_ready', database: 'unavailable' });
  }
});

app.use('/api', apiRoutes);

// Unmigrated routes fail explicitly instead of returning fake success.
app.use('/api', (_req, res) => {
  res.status(501).json({ error: 'This Clutch Arena API route is not migrated yet.' });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('API request failed:', err instanceof Error ? err.message : 'Unknown error');
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(port, () => {
  console.log(`Clutch Arena API listening on port ${port}`);
});

// Archive team results, then remove completed events 24 hours after completion.
let cleanupRunning=false;
const runCleanup=async()=>{
  if(cleanupRunning) return;
  cleanupRunning=true;
  try {
    const removed=await cleanupCompletedEvents();
    if(removed) console.log(`Archived and cleaned ${removed} completed event(s)`);
  } catch(error) {
    console.error('Completed-event cleanup failed:',error instanceof Error?error.message:'Unknown error');
  } finally {
    cleanupRunning=false;
  }
};
void runCleanup();
const cleanupTimer=setInterval(()=>void runCleanup(),5*60*1000);


async function shutdown() {
  clearInterval(cleanupTimer);
  server.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
