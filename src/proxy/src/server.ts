import express from 'express';
import { config } from './config.js';
import { getDb } from './db/connection.js';
import { pruneAllRequestStats } from './db/requestStatsRepo.js';
import { requireApiKey } from './auth/apiKey.js';
import { requireIdentityHeader } from './auth/identityHeader.js';
import { requireInternalToken } from './auth/internalAuth.js';
import { compatibleRouter } from './routes/compatible.js';
import { adminApiRouter } from './routes/adminApi.js';
import { internalApiRouter } from './routes/internalApi.js';

export function buildApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', service: 'proxy' });
  });
  app.use('/api', requireInternalToken, adminApiRouter);
  app.use('/internal', requireInternalToken, internalApiRouter);
  app.use(requireApiKey, requireIdentityHeader, compatibleRouter);
  app.use((req, res) => {
    const message =
      `Unsupported Copilot API path: ${req.originalUrl}. ` +
      supportedPathsMessage();
    if (req.path.startsWith('/v1/messages')) {
      res.status(404).json({ type: 'error', error: { type: 'invalid_request_error', message } });
      return;
    }
    res.status(404).json({ error: { message, type: 'invalid_request_error' } });
  });
  return app;
}

function supportedPathsMessage(): string {
  const paths = ['GET /v1/models', 'POST /chat/completions', 'POST /v1/messages', 'POST /responses'];
  if (config.claudeCodeOptimized) paths.splice(3, 0, 'POST /v1/messages/count_tokens');
  return `Supported paths: ${paths.join(', ')}.`;
}

export function startServer(): void {
  getDb();
  pruneAllRequestStats();
  buildApp().listen(config.port, () => {
    console.log(`[proxy] listening on http://localhost:${config.port}`);
  });
}
