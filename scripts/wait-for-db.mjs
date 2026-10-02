#!/usr/bin/env node
// Blocks until Postgres accepts connections, so `npm run setup` can chain
// docker compose up -> migrate -> seed without racing the container's startup.
import net from 'node:net';

const host = process.env.PGHOST ?? 'localhost';
const port = Number(process.env.PGPORT ?? 5433);
const timeoutMs = 60_000;
const started = Date.now();

function attempt() {
  const socket = net.connect({ host, port });
  socket.once('connect', () => {
    socket.destroy();
    console.log(`Postgres is accepting connections on ${host}:${port}`);
    process.exit(0);
  });
  socket.once('error', () => {
    socket.destroy();
    if (Date.now() - started > timeoutMs) {
      console.error(`Timed out after ${timeoutMs / 1000}s waiting for Postgres on ${host}:${port}`);
      process.exit(1);
    }
    setTimeout(attempt, 750);
  });
}
attempt();
