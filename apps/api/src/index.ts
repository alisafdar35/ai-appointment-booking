import { createServer } from 'node:http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { closePool, pool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { closeRealtime, initRealtime } from './realtime/index.js';

async function main(): Promise<void> {
  // Fail at boot, loudly, if the database is unreachable — rather than serving
  // a healthy-looking process whose every request 500s.
  await pool.query('SELECT 1');

  const app = createApp();
  const server = createServer(app);
  initRealtime(server);

  server.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, ai: env.aiEnabled ? `mistral:${env.MISTRAL_MODEL}` : 'fallback-only' },
      'API listening',
    );
  });

  /**
   * Graceful shutdown. On SIGTERM (every platform's deploy/scale-down signal)
   * stop accepting connections, let in-flight requests finish, then close the
   * socket gateway and pool. The timer is a backstop for a hung connection —
   * unref'd so it never holds the process open on its own.
   */
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    const force = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    force.unref();
    void closeRealtime()
      .then(() => new Promise<void>((resolve) => server.close(() => resolve())))
      .then(() => closePool())
      .then(() => process.exit(0))
      .catch((err) => {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
}

main().catch((err) => {
  // The logger may not have flushed yet; console guarantees the message appears.
  console.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
