import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** Keep CMaps offline and aligned with the installed PDF.js worker version. */
export function pdfCMapAssets(): Plugin {
  const require = createRequire(import.meta.url);
  const directory = resolve(dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps');

  return {
    name: 'pdf-cmap-assets',
    apply: 'build',
    buildStart() {
      const maps = readdirSync(directory)
        .filter((name) => name.endsWith('.bcmap'))
        .sort();
      if (maps.length === 0)
        throw new Error('The installed PDF.js package contains no packed CMaps');

      // buildStart runs again in `vite build --watch`; emit into every output.
      this.addWatchFile(directory);
      for (const name of [...maps, 'LICENSE']) {
        const path = resolve(directory, name);
        this.addWatchFile(path);
        this.emitFile({ type: 'asset', fileName: `cmaps/${name}`, source: readFileSync(path) });
      }
    },
  };
}
