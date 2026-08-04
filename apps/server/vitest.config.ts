import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'test/**/*.test.ts'],
    hookTimeout: 120_000,
    testTimeout: 120_000,
  },
  plugins: [
    // SWC is required so NestJS/TypeORM decorator metadata is emitted for tests.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
