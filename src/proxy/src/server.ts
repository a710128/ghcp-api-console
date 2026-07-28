import express, { type Request, type Response } from 'express';
import { config } from './config.js';
import { initPool, getGeneralPool } from './db/connection.js';
import { requireApiKey } from './auth/apiKey.js';
import { requireIdentityHeader } from './auth/identityHeader.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { compatibleRouter } from './routes/compatible.js';
import { resolveClaudeCodeOptimized } from './routes/claudeCodeMode.js';
import { adminApiRouter } from './routes/adminApi.js';
import { internalApiRouter } from './routes/internalApi.js';

let activeRequests = 0;
let isReady = false;

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.use((_req, res, next) => {
    activeRequests++;
    res.on('finish', () => { if (activeRequests > 0) activeRequests--; });
    res.on('close', () => { if (activeRequests > 0) activeRequests--; });
    next();
  });
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'proxy' });
  });
  app.get('/readyz', async (_req, res) => {
    if (!isReady) {
      res.status(503).json({ status: 'not_ready', service: 'proxy', reason: 'Startup not complete.' });
      return;
    }
    try {
      const pool = getGeneralPool();
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      res.json({ status: 'ok', service: 'proxy', activeRequests });
    } catch (err) {
      res.status(503).json({ status: 'not_ready', service: 'proxy', reason: `Database check failed: ${(err as Error).message}` });
    }
  });
  app.use('/api', requireInternalToken, adminApiRouter);
  app.use('/internal', requireInternalToken, internalApiRouter);
  app.use(requireApiKey, requireIdentityHeader, compatibleRouter);
  app.use((req, res) => {
    const claudeCodeOptimized = resolveClaudeCodeOptimized(req);
    if (!claudeCodeOptimized.ok) {
      sendInvalidRequestError(req, res, claudeCodeOptimized.message);
      return;
    }
    const message =
      `Unsupported Copilot API path: ${req.originalUrl}. ` +
      supportedPathsMessage(claudeCodeOptimized.enabled);
    if (req.path.startsWith('/v1/messages')) {
      res.status(404).json({ type: 'error', error: { type: 'invalid_request_error', message } });
      return;
    }
    res.status(404).json({ error: { message, type: 'invalid_request_error' } });
  });
  return app;
}

function supportedPathsMessage(claudeCodeOptimized: boolean): string {
  const paths = ['GET /v1/models', 'POST /v1/chat/completions', 'POST /v1/messages', 'POST /v1/responses'];
  if (claudeCodeOptimized) paths.splice(3, 0, 'POST /v1/messages/count_tokens');
  return `Supported paths: ${paths.join(', ')}.`;
}

function sendInvalidRequestError(req: Request, res: Response, message: string): void {
  if (req.path.startsWith('/v1/messages')) {
    res.status(400).json({ type: 'error', error: { type: 'invalid_request_error', message } });
    return;
  }
  res.status(400).json({ error: { message, type: 'invalid_request_error' } });
}

export async function startServer(): Promise<void> {
  await initPool();
  isReady = true;
  const server = buildApp().listen(config.port, () => {
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'startup', service: 'proxy', port: config.port }));
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ time: new Date().toISOString(), event: 'shutdown', service: 'proxy', signal }));
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
