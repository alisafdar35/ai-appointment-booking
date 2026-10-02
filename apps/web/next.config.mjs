// @ts-check

const API_ORIGIN = (process.env.API_ORIGIN ?? 'http://localhost:4000').replace(/\/$/, '');
const SOCKET_ORIGIN = new URL(process.env.NEXT_PUBLIC_SOCKET_URL ?? 'http://localhost:4000').origin;
const isProd = process.env.NODE_ENV === 'production';

/**
 * Content-Security-Policy.
 *
 * Next.js emits inline bootstrap scripts, so `script-src` needs 'unsafe-inline'
 * unless every response carries a per-request nonce (which forces dynamic
 * rendering for the whole app). That is the wrong trade for a prototype, so the
 * policy still locks down everything else: no framing, no foreign form posts,
 * and network access only to this origin and the Socket.IO server.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self' ${SOCKET_ORIGIN} ${SOCKET_ORIGIN.replace(/^http/, 'ws')}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isProd
    ? [
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        { key: 'Content-Security-Policy', value: csp },
      ]
    : []),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // The e2e runner (scripts/e2e.mjs) builds into its own directory, pointed at
  // its own API, so it never replaces a development build in .next.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  reactStrictMode: true,
  poweredByHeader: false,
  // @appt/shared ships compiled CommonJS; transpiling it lets Next bundle it
  // for the browser like first-party code.
  transpilePackages: ['@appt/shared'],
  async rewrites() {
    // The browser only ever talks to its own origin. Proxying keeps the auth
    // cookies first-party (no CORS, no SameSite=None) — see apps/api auth routes.
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
