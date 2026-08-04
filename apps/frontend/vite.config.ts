/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api/v1': {
        target: 'http://localhost:3001',
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
