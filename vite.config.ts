import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'path';
import manifest from './manifest.config';

// Only public source files are hashed. Environment files are never enumerated/read.
const buildHash = createHash('sha256');
for (const directory of ['src/lib', 'src/background', 'src/offscreen'])
  for (const file of readdirSync(directory)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort())
    buildHash.update(`${directory}/${file}`).update(readFileSync(`${directory}/${file}`));
export default defineConfig({
  define: { __SUMMARY_BUILD_DIGEST__: JSON.stringify(buildHash.digest('hex')) },
  envDir: false,
  plugins: [react(), tailwindcss(), crx({ manifest })],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    sourcemap: process.env.NODE_ENV === 'development',
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'offscreen.html'),
      },
    },
  },
});
