import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // @appt/shared is compiled CommonJS in a symlinked workspace folder; Vite
    // would otherwise try to transform it as ESM and fail on `exports`.
    server: { deps: { external: [/packages\/shared\/dist/] } },
  },
});
