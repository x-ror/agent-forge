/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // @agentforge/core's dist is CJS; the linked workspace package must be
    // pre-bundled or `vite dev` fails on its named exports (build is fine).
    include: ['@agentforge/core'],
  },
  server: {
    port: 3000,
    proxy: {
      '/api/v1': {
        // Point at the compose stack's nginx (http://localhost:3000) when the
        // api container publishes no host port: AGENTFORGE_DEV_API=... pnpm dev
        target: process.env.AGENTFORGE_DEV_API ?? 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
  css: {
    preprocessorOptions: {
      scss: {
        // Carbon's sass needs the package importer.
        loadPaths: ['node_modules', '../../node_modules'],
        silenceDeprecations: ['mixed-decls', 'global-builtin'],
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    css: false,
  },
});
