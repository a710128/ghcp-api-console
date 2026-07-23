import { startServer } from './server.js';

startServer().catch((err: unknown) => {
  console.error('[login] Startup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
