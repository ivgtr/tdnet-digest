/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type { EmittedFile, NormalizedInputOptions, PluginContext } from 'rollup';
import { expect, it } from 'vitest';
import { pdfCMapAssets } from '../../vite-plugins/pdf-cmaps';

it('emits every installed packed CMap and license on each build and watches their sources', async () => {
  const require = createRequire(import.meta.url);
  const directory = resolve(dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps');
  const expectedNames = readdirSync(directory)
    .filter((name) => name.endsWith('.bcmap') || name === 'LICENSE')
    .sort();
  expect(expectedNames).toContain('LICENSE');
  expect(expectedNames).toContain('90ms-RKSJ-H.bcmap');
  const plugin = pdfCMapAssets();
  const hook = plugin.buildStart;
  if (typeof hook !== 'function') throw new Error('Expected a buildStart function');
  // Exercise the real hook twice: Rollup needs fresh emissions on watch rebuilds.
  // Only the host context is replaced; all asset names and bytes come from PDF.js.
  for (let build = 0; build < 2; build++) {
    const assets: EmittedFile[] = [];
    const watched: string[] = [];
    const context = {
      addWatchFile: (path: string) => watched.push(path),
      emitFile: (asset: EmittedFile) => String(assets.push(asset)),
    };
    await hook.call(context as unknown as PluginContext, {} as NormalizedInputOptions);
    expect(watched.sort()).toEqual(
      [directory, ...expectedNames.map((name) => resolve(directory, name))].sort()
    );
    expect(assets.map((asset) => asset.fileName).sort()).toEqual(
      expectedNames.map((name) => `cmaps/${name}`)
    );
    for (const asset of assets) {
      if (asset.type !== 'asset' || !asset.fileName || asset.source === undefined)
        throw new Error('Expected a named asset with source bytes');
      expect(
        Buffer.from(asset.source).equals(readFileSync(resolve(directory, asset.fileName.slice(6)))),
        asset.fileName
      ).toBe(true);
    }
  }
});
