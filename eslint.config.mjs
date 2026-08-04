import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**', '**/*.d.ts'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    // DDD domain purity (architecture invariant #3): domain layers are pure TS.
    // No framework, no ORM, no queue client, no outer-layer imports.
    files: ['apps/server/src/contexts/*/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', 'typeorm', 'bullmq', 'ioredis', 'pg', 'express'],
              message: 'Domain layer must stay framework-free (DDD purity invariant).',
            },
            {
              group: ['**/application/**', '**/infrastructure/**', '**/interface/**'],
              message: 'Domain layer cannot depend on outer layers.',
            },
          ],
        },
      ],
    },
  },
  {
    // Application layer: may use Nest DI + cqrs, but never persistence/transport details.
    files: ['apps/server/src/contexts/*/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['typeorm', 'pg', 'express'],
              message: 'Application layer may not touch persistence/transport directly.',
            },
            {
              group: ['**/infrastructure/**', '**/interface/**'],
              message: 'Application layer cannot depend on infrastructure or interface layers.',
            },
          ],
        },
      ],
    },
  },
  {
    // packages/core is framework-free by definition.
    files: ['packages/core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@nestjs/*', 'typeorm', 'bullmq', 'ioredis', 'pg', 'express', 'react'],
              message: 'packages/core must stay framework-free.',
            },
          ],
        },
      ],
    },
  },
);
