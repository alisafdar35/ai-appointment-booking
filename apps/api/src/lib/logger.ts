import pino from 'pino';
import { env } from '../config/env.js';

/**
 * Structured JSON logs in production (machine-parseable for any log platform),
 * human-readable in development.
 *
 * `redact` is the important part: these paths are stripped before anything is
 * written, so a credential cannot reach the log aggregator by accident.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'password',
      '*.password',
      'passwordHash',
      '*.passwordHash',
      'token',
      '*.token',
      'accessToken',
      '*.accessToken',
      'refreshToken',
      '*.refreshToken',
    ],
    censor: '[redacted]',
  },
  // Pretty-printing runs in a worker thread, which is pointless when nothing is
  // logged — and the test suite, which silences logs, starts one per process.
  ...(env.isProduction || env.LOG_LEVEL === 'silent'
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});
