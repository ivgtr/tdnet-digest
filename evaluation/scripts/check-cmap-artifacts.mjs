// Run after the normal production build; do not launch a duplicate build in Vitest.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const source = resolve(dirname(require.resolve('pdfjs-dist/package.json')), 'cmaps');
const output = resolve(process.argv[2] ?? 'dist', 'cmaps');
const names = readdirSync(source)
  .filter((name) => name.endsWith('.bcmap') || name === 'LICENSE')
  .sort();
assert(names.includes('LICENSE'));
assert(names.includes('90ms-RKSJ-H.bcmap'));
assert.deepEqual(readdirSync(output).sort(), names);
for (const name of names)
  assert.deepEqual(readFileSync(resolve(output, name)), readFileSync(resolve(source, name)), name);
console.log(`Verified ${names.length - 1} packed CMaps + LICENSE byte-for-byte in ${output}`);
