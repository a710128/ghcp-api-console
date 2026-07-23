import express from 'express';
import cookieSession from 'cookie-session';
import { apiError } from '@ghcp/shared';
import { config } from './config.js';
import { initPool, getGeneralPool } from './db/connection.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { usersApiRouter } from './routes/usersApi.js';
import { budgetApiRouter } from './routes/budgetApi.js';
import { samlRouter } from './routes/samlRoutes.js';

let isReady = false;
let activeRequests = 0;

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(cookieSession({ name: 'sso_session', secret: config.sessionSecret, httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 }));
  app.use((_req, res, next) => {
    activeRequests++;
    res.on('finish', () => { if (activeRequests > 0) activeRequests--; });
    res.on('close', () => { if (activeRequests > 0) activeRequests--; });
    next();
  });
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'sso' });
  });
  app.get('/readyz', async (_req, res) => {
    if (!isReady) {
      res.status(503).json({ status: 'not_ready', service: 'sso', reason: 'Startup not complete.' });
      return;
    }
    try {
      const pool = getGeneralPool();
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      res.json({ status: 'ok', service: 'sso', activeRequests });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', service: 'sso', reason: `Database check failed: ${(err as Error).message}` });
    }
  });
  app.use(samlRouter);
  app.use('/api', requireInternalToken, usersApiRouter, budgetApiRouter);
  app.use((_req, res) => {
    res.status(404).json(apiError('not_found', 'SSO route is not implemented yet.'));
  });
  return app;
}

export async function startServer(): Promise<void> {
  await initPool();
  isReady = true;
  const server = buildApp().listen(config.port, () => {
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'startup', service: 'sso', baseUrl: config.baseUrl }));
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[sso] failed to listen on port ${config.port}: address already in use`);
      process.exitCode = 1;
      return;
    }
    throw err;
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'shutdown', service: 'sso', signal }));
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
