#!/usr/bin/env node
/**
 * Runs the Playwright suite against a stack of its own, end to end:
 *
 *   1. drop and recreate the e2e database (only a local one whose name ends in _e2e)
 *   2. build @appt/shared, the API and the web app (the web app into .next-e2e,
 *      so a development build in .next is left alone)
 *   3. migrate with the real runner and seed with db/seed.sql
 *   4. boot the API (:4100, no Mistral key, rate limits off) and the production
 *      web build (:3100, proxying to that API), and wait until both are healthy
 *   5. run Playwright against them
 *   6. stop both servers, whether the tests passed, failed or were interrupted
 *
 *   npm run e2e                              everything above
 *   npm run e2e -- --project=desktop         extra arguments go to Playwright
 *   npm run e2e -- --skip-build              reuse the last build (DB is still reset)
 *
 * Environment (all optional):
 *   E2E_DATABASE_URL  default postgresql://appt:appt_local_dev@localhost:5433/appt_e2e
 *   E2E_API_PORT      default 4100
 *   E2E_WEB_PORT      default 3100
 *   E2E_LOG_DIR       where the servers' output goes; default <os tmpdir>/slotly-e2e
 *
 * The values the API gets are set here in full, so nothing from the repo's
 * .env (a Mistral key, the dev database) can leak into the run.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB_DIR = path.join(ROOT, 'apps/web');
const API_DIR = path.join(ROOT, 'apps/api');
const WEB_DIST_DIR = '.next-e2e';
const LOG_DIR = process.env.E2E_LOG_DIR ?? path.join(tmpdir(), 'slotly-e2e');

const DATABASE_URL = process.env.E2E_DATABASE_URL ?? 'postgresql://appt:appt_local_dev@localhost:5433/appt_e2e';
const API_PORT = Number(process.env.E2E_API_PORT ?? 4100);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3100);
const API_ORIGIN = `http://localhost:${API_PORT}`;
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const playwrightArgs = args.filter((arg) => arg !== '--skip-build');

const children = [];
/** The Playwright process while it runs, so an interrupt can be passed on to it. */
let activeRunner;
let stopping = false;
// Next.js and Playwright are apps/web's dependencies, so they are resolved from there.
const webRequire = createRequire(path.join(WEB_DIR, 'package.json'));

// ---- helpers ----------------------------------------------------------------

const log = (message) => console.log(`\x1b[36m[e2e]\x1b[0m ${message}`);

/** Run a command to completion with inherited output; throw if it fails. */
function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    // npm is npm.cmd on Windows, which only a shell can start.
    shell: process.platform === 'win32',
    ...options,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(' ')} exited with ${result.status ?? result.signal}`);
  }
}

/** Start a long-running server, its output going to a log file. */
function start(name, commandArgs, { cwd, env }) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logFile = path.join(LOG_DIR, `${name}.log`);
  const out = createWriteStream(logFile);
  const child = spawn(process.execPath, commandArgs, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group on POSIX, so stopping it also stops anything it spawned.
    detached: process.platform !== 'win32',
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const entry = { name, child, logFile, exited: false };
  child.once('exit', () => {
    entry.exited = true;
  });
  children.push(entry);
  return entry;
}

/** Stop every server this script started, and wait until they have exited (ports free again). */
async function stopAll() {
  stopping = true;
  const running = children.filter((entry) => !entry.exited && entry.child.pid !== undefined);
  const signal = (entry, name) => {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(entry.child.pid), '/T', '/F']);
      else process.kill(-entry.child.pid, name);
    } catch {
      // Already gone.
    }
  };
  running.forEach((entry) => signal(entry, 'SIGTERM'));
  const deadline = Date.now() + 10_000;
  while (running.some((entry) => !entry.exited) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  running.filter((entry) => !entry.exited).forEach((entry) => signal(entry, 'SIGKILL'));
}

function tail(file, lines = 40) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '(no output)';
  }
}

/** True when something already listens on the port: the suite must never test a stranger's stack. */
function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: 'localhost', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForHealth(url, server, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exited) {
      throw new Error(`The ${server.name} server exited during startup:\n${tail(server.logFile)}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} was not healthy within ${timeoutMs / 1000}s:\n${tail(server.logFile)}`);
}

// ---- steps --------------------------------------------------------------------

/**
 * Drop and recreate the e2e database. Guarded twice, because DROP DATABASE is
 * not something to point at the wrong server: the name must end in _e2e, and
 * the host must be this machine.
 */
async function resetDatabase() {
  const url = new URL(DATABASE_URL);
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!/^[a-z0-9_]+_e2e$/.test(name)) {
    throw new Error(`Refusing to reset "${name}": the e2e database name must end in _e2e (E2E_DATABASE_URL).`);
  }
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error(`Refusing to reset a database on ${url.hostname}: the e2e database must be local.`);
  }

  const admin = new URL(DATABASE_URL);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    // FORCE (Postgres 13+) ends connections a previous, interrupted run left open.
    await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${name}"`);
  } finally {
    await client.end();
  }
  log(`Recreated database ${name} on ${url.host}`);
}

/** Everything the API reads, set explicitly so the repo's .env cannot contribute. */
const apiEnv = {
  NODE_ENV: 'development',
  PORT: String(API_PORT),
  DATABASE_URL,
  DATABASE_SSL: 'false',
  // Fresh per run: nothing outside this run can mint a token the API accepts.
  JWT_SECRET: randomBytes(48).toString('hex'),
  CORS_ORIGINS: WEB_ORIGIN,
  CROSS_SITE_COOKIES: 'false',
  TRUST_PROXY_HOPS: '0',
  // Blank counts as unset (env.ts), and dotenv never overrides a variable that
  // is present, so the .env key stays out: the guided engine answers every turn.
  MISTRAL_API_KEY: '',
  RATE_LIMIT_DISABLED: 'true',
  LOG_LEVEL: 'warn',
};

/** Next.js reads these at build time (the /api rewrite and the CSP) and at start (next.config). */
const webEnv = {
  API_ORIGIN,
  NEXT_PUBLIC_SOCKET_URL: API_ORIGIN,
  NEXT_DIST_DIR: WEB_DIST_DIR,
  NEXT_TELEMETRY_DISABLED: '1',
};

/**
 * `next build` points next-env.d.ts (and the tsconfig include list) at the
 * dist dir it builds into. Those files are committed with the default .next,
 * so they are put back afterwards and the build leaves the worktree clean.
 */
function buildWeb() {
  const tracked = ['next-env.d.ts', 'tsconfig.json'].map((file) => path.join(WEB_DIR, file));
  const saved = tracked.map((file) => readFileSync(file));
  try {
    run('npm', ['run', 'build', '-w', '@appt/web'], { env: webEnv });
  } finally {
    tracked.forEach((file, index) => {
      if (!readFileSync(file).equals(saved[index])) writeFileSync(file, saved[index]);
    });
  }
}

async function main() {
  for (const port of [API_PORT, WEB_PORT]) {
    if (await portInUse(port)) {
      throw new Error(`Port ${port} is already in use. Stop whatever runs there, or set E2E_API_PORT / E2E_WEB_PORT.`);
    }
  }

  await resetDatabase();

  if (skipBuild) {
    log('Skipping the build (--skip-build)');
  } else {
    log('Building');
    run('npm', ['run', 'build:shared']);
    run('npm', ['run', 'build', '-w', '@appt/api']);
    buildWeb();
  }

  log('Migrating and seeding');
  run(process.execPath, ['dist/db/migrate.js'], { cwd: API_DIR, env: apiEnv });
  run(process.execPath, ['dist/db/seed.js'], { cwd: API_DIR, env: apiEnv });

  log(`Starting the API on ${API_ORIGIN} and the web app on ${WEB_ORIGIN} (logs in ${LOG_DIR})`);
  const api = start('api', ['dist/index.js'], { cwd: API_DIR, env: apiEnv });
  const nextBin = path.join(path.dirname(webRequire.resolve('next/package.json')), 'dist/bin/next');
  const web = start('web', [nextBin, 'start', '-p', String(WEB_PORT)], { cwd: WEB_DIR, env: webEnv });

  const health = await waitForHealth(`${API_ORIGIN}/api/health`, api);
  // Through the web app's own proxy, the way the browser reaches the API.
  await waitForHealth(`${WEB_ORIGIN}/api/health`, web);
  log(`Stack is up (database ${health.db}, assistant ${health.aiProvider})`);

  const playwrightCli = webRequire.resolve('@playwright/test/cli');
  const playwright = spawn(process.execPath, [playwrightCli, 'test', ...playwrightArgs], {
    cwd: WEB_DIR,
    stdio: 'inherit',
    env: { ...process.env, E2E_BASE_URL: WEB_ORIGIN },
  });
  activeRunner = playwright;
  const status = await new Promise((resolve) => playwright.once('exit', (code) => resolve(code ?? 1)));
  activeRunner = undefined;
  for (const server of [api, web]) {
    if (server.exited && !stopping) console.error(`\nThe ${server.name} server stopped during the run:\n${tail(server.logFile)}`);
  }
  return status;
}

// ---- entry ------------------------------------------------------------------

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    activeRunner?.kill(signal);
    void stopAll().finally(() => process.exit(130));
  });
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (error) {
  console.error(`\n\x1b[31m[e2e]\x1b[0m ${error instanceof Error ? error.message : error}`);
} finally {
  await stopAll();
}
process.exit(exitCode);
