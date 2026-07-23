import { startServer } from './server.js';

startServer().catch((err: unknown) => {
  console.error('[sso] Startup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
