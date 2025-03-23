import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/*.ts', '**/?(*.)+(spec|test).ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['index.ts'],
      exclude: ['__tests__/**', '__mocks__/**']
    }
  }
});
