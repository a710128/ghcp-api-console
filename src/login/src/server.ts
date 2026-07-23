import express from 'express';
import { apiError } from '@ghcp/shared';
import { config } from './config.js';
import { initPool, getGeneralPool } from './db/connection.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { tasksApiRouter } from './routes/tasksApi.js';

let isReady = false;
let activeRequests = 0;

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use((_req, res, next) => {
    activeRequests++;
    res.on('finish', () => { if (activeRequests > 0) activeRequests--; });
    res.on('close', () => { if (activeRequests > 0) activeRequests--; });
    next();
  });
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'login' });
  });
  app.get('/readyz', async (_req, res) => {
    if (!isReady) {
      res.status(503).json({ status: 'not_ready', service: 'login', reason: 'Startup not complete.' });
      return;
    }
    try {
      const pool = getGeneralPool();
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      res.json({ status: 'ok', service: 'login', activeRequests });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', service: 'login', reason: `Database check failed: ${(err as Error).message}` });
    }
  });
  app.use('/api', requireInternalToken, tasksApiRouter);
  app.use((_req, res) => {
    res.status(404).json(apiError('not_found', 'Login route is not implemented yet.'));
  });
  return app;
}

export async function startServer(): Promise<void> {
  await initPool();
  isReady = true;
  const server = buildApp().listen(config.port, () => {
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'startup', service: 'login', port: config.port }));
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'shutdown', service: 'login', signal }));
    isReady = false;
    server.close();
    const deadline = Date.now() + 30_000;
    while (activeRequests > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    process.exit(activeRequests > 0 ? 1 : 0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
