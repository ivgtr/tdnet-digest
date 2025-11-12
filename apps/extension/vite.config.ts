import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import type { Plugin } from 'vite';

// Custom plugin to copy manifest and public files
function copyManifestPlugin(): Plugin {
  return {
    name: 'copy-manifest',
    writeBundle() {
      const dist = resolve(__dirname, 'dist');
      const publicDir = resolve(__dirname, 'public');

      // Create dist directory if it doesn't exist
      if (!existsSync(dist)) {
        mkdirSync(dist, { recursive: true });
      }

      // Copy manifest.json
      const manifestSrc = resolve(publicDir, 'manifest.json');
      const manifestDest = resolve(dist, 'manifest.json');
      if (existsSync(manifestSrc)) {
        copyFileSync(manifestSrc, manifestDest);
        console.log('✓ Copied manifest.json');
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), copyManifestPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: process.env.NODE_ENV === 'development',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        options: resolve(__dirname, 'options.html'),
        content: resolve(__dirname, 'src/content/index.tsx'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          // Keep content and background scripts in their own directories
          if (chunkInfo.name === 'content' || chunkInfo.name === 'background') {
            return '[name]/index.js';
          }
          return '[name]/index.js';
        },
        chunkFileNames: 'chunks/[name].[hash].js',
        assetFileNames: (assetInfo) => {
          // Handle CSS from content script
          if (assetInfo.name?.endsWith('.css')) {
            return 'content/style.css';
          }
          return 'assets/[name].[ext]';
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
