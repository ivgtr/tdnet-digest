/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';
import { pdfCMapAssets } from '../../vite-plugins/pdf-cmaps';

it('bundles every installed packed CMap and its license byte-for-byte', async () => {
  const require = createRequire(import.meta.url);
  const directory = resolve(dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps');
  const result = await build({
    configFile: false,
    envDir: false,
    publicDir: false,
    logLevel: 'silent',
    plugins: [
      pdfCMapAssets(),
      {
        name: 'empty-cmap-test-entry',
        resolveId: (id) => (id === 'cmap-test' ? '\0cmap-test' : null),
        load: (id) => (id === '\0cmap-test' ? 'export {}' : null),
      },
    ],
    build: { write: false, rollupOptions: { input: 'cmap-test' } },
  });
  if ('on' in result || Array.isArray(result)) throw new Error('Expected a single build output');
  const assets = result.output.filter((asset) => asset.type === 'asset');
  const expectedNames = readdirSync(directory)
    .filter((name) => name.endsWith('.bcmap') || name === 'LICENSE')
    .sort();
  expect(expectedNames).toContain('LICENSE');
  expect(expectedNames).toContain('90ms-RKSJ-H.bcmap');
  expect(assets.map((asset) => asset.fileName).sort()).toEqual(
    expectedNames.map((name) => `cmaps/${name}`)
  );
  for (const asset of assets) {
    expect(Buffer.from(asset.source)).toEqual(
      readFileSync(resolve(directory, asset.fileName.slice(6)))
    );
  }
});
