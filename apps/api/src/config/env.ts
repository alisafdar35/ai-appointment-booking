import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

// Load .env from the repo root so one file serves the whole monorepo locally.
// In production every value comes from the platform's environment.
loadDotenv({ path: new URL('../../../../.env', import.meta.url).pathname });
loadDotenv();

/**
 * Environment is validated once, at boot, and the process refuses to start if
 * anything required is missing or malformed. The alternative — reading
 * `process.env.FOO!` at the call site — turns a config typo into a 500 at 3am
 * instead of a clear crash on deploy.
 */
const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    DATABASE_SSL: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
    PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900), // 15 min
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),

    /** Comma-separated exact origins. Credentialed CORS forbids '*'. */
    CORS_ORIGINS: z.string().default('http://localhost:3000'),
    /** Set when API and web are on different sites so cookies need SameSite=None. */
    CROSS_SITE_COOKIES: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),

    /**
     * How many reverse proxies sit between the client and this process, each
     * appending to X-Forwarded-For. 0 trusts the header not at all, which is
     * right when nothing is in front (a client could otherwise pick its own
     * rate-limit key). The Vercel -> Render deployment has two: the web app's
     * /api rewrite, then Render's edge (render.yaml sets this).
     */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),

    MISTRAL_API_KEY: z.string().trim().min(1).optional(),
    /**
     * A small, fast model is enough here: its whole job is slot extraction into
     * a schema-validated tool call, which code then checks. ministral-8b is
     * also available on Mistral's free tier, where larger models may have no
     * quota at all.
     */
    MISTRAL_MODEL: z.string().default('ministral-8b-latest'),
    MISTRAL_BASE_URL: z.string().url().default('https://api.mistral.ai'),
    AI_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(12000),
    AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
    /** Turns of history sent to the model. Caps cost and latency growth. */
    AI_HISTORY_TURNS: z.coerce.number().int().min(2).max(40).default(12),

    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    RATE_LIMIT_DISABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((v) => v === 'true'),
  })
  // The .env.example value is published in the repository, so anyone could
  // forge access tokens with it. Refusing it in production turns a copied
  // example file into a failed deploy instead of a silent hole.
  .refine((e) => !(e.NODE_ENV === 'production' && e.JWT_SECRET.startsWith('replace-me')), {
    message: 'JWT_SECRET is still the .env.example placeholder',
    path: ['JWT_SECRET'],
  })
  .transform((e) => ({
    ...e,
    isProduction: e.NODE_ENV === 'production',
    isTest: e.NODE_ENV === 'test',
    // Browsers send Origin as scheme://host[:port] with no path, so an entry
    // pasted as "https://app.example.com/" would never match. Normalise to the
    // bare origin; an entry that is not a URL is kept as typed.
    corsOrigins: e.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
      .map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          return o;
        }
      }),
    /** Whether the LLM path is even possible. Checked once, not per request. */
    aiEnabled: Boolean(e.MISTRAL_API_KEY),
  }));

// `KEY=` in a .env file (as .env.example ships for optional keys) arrives as an
// empty string, which would fail `.min(1)` on an optional value. Treat blank as unset.
const rawEnv = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ''));

const parsed = envSchema.safeParse(rawEnv);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  // Written with console on purpose: the logger itself depends on this config.
  console.error(`\n✖ Invalid environment configuration:\n${issues.join('\n')}\n`);
  console.error('Copy .env.example to .env and fill in the required values.\n');
  process.exit(1);
}

export const env = parsed.data;
