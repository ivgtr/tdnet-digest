import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
