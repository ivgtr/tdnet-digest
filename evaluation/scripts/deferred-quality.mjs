#!/usr/bin/env node
/** Deliberately offline. --execute/--live and unknown flags are rejected. */
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDigest,
  freezePlan,
  importDiagnostic,
  comparisonReport,
  reviewTemplate,
  sha256,
  validatePlan,
  writeOnce,
} from './deferred-quality/core.mjs';

const readJSON = async (file) => JSON.parse(await readFile(file, 'utf8'));
const corpusPath = fileURLToPath(
  new URL('../fixtures/source-first-quality-cases.json', import.meta.url)
);
const help = `Offline source-first evaluation (no API requests; .env is never read)
  digest --checkout DIR
  plan --config FILE --pdf-dir DIR --out NEW_PLAN.json [--cases FILE]
  import --plan FILE --run ID --summary FILE [--analysis FILE] --out DIR [--review FILE] [--evidence-kind live-generation]
  review-template --plan FILE --run ID --out NEW_REVIEW.json
  report --plan FILE --records DIR --out NEW_REPORT.json [--reviews DIR]

One fixed run = summary, plus optional analysis as specified by the plan.
Copy each extension diagnostic immediately after generation, including failures.
All outputs are exclusive writes. Never replace a failed run or count cached output as a repeat.
No --execute/--live command exists. See evaluation/source-first-quality.md.`;
const optionsByCommand = {
  digest: ['--checkout'],
  plan: ['--config', '--pdf-dir', '--out', '--cases'],
  import: ['--plan', '--run', '--summary', '--analysis', '--out', '--review', '--evidence-kind'],
  'review-template': ['--plan', '--run', '--out'],
  report: ['--plan', '--records', '--out', '--reviews'],
};
export function parseArgs(args) {
  if (!args.length || (args.length === 1 && args[0] === '--help'))
    return { command: 'help', options: {} };
  const [command, ...rest] = args;
  if (!optionsByCommand[command])
    throw new Error('Unknown command. This tool has no live/API execution mode.');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!optionsByCommand[command].includes(key) || key in options)
      throw new Error(`Unknown/duplicate option: ${key}`);
    if (!rest[i + 1] || rest[i + 1].startsWith('--')) throw new Error(`Missing value: ${key}`);
    options[key] = rest[i + 1];
  }
  return { command, options };
}
const requireOption = (options, key) => {
  if (!options[key]) throw new Error(`Explicit ${key} is required`);
  return options[key];
};
async function readRecords(directory) {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const runDirectory = path.join(directory, entry.name);
    let filename = path.join(runDirectory, 'record.json');
    try {
      await stat(filename);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      // A failed downstream review/import still retains request checkpoints.
      filename = path.join(runDirectory, 'checkpoint.json');
    }
    results.push(await readJSON(filename));
  }
  return results;
}
export async function main(args) {
  const { command, options } = parseArgs(args);
  if (command === 'help') {
    console.log(help);
    return;
  }
  if (command === 'digest') {
    console.log(await buildDigest(requireOption(options, '--checkout')));
    return;
  }
  if (command === 'plan') {
    const config = await readJSON(requireOption(options, '--config'));
    const plan = freezePlan(config, await readJSON(options['--cases'] ?? corpusPath));
    const pdfDirectory = requireOption(options, '--pdf-dir');
    for (const item of plan.cases) {
      const bytes = await readFile(path.join(pdfDirectory, `${item.id}.pdf`));
      if (sha256(bytes) !== item.pdfSha256)
        throw new Error(`${item.id}: local PDF SHA-256 mismatch`);
    }
    await writeOnce(requireOption(options, '--out'), plan);
    console.log(
      JSON.stringify({
        offline: true,
        planHash: plan.planHash,
        ...plan.budget,
        settingsMatch: plan.settingsMatch,
      })
    );
    return;
  }
  const plan = validatePlan(await readJSON(requireOption(options, '--plan')));
  if (command === 'import') {
    const record = await importDiagnostic(
      plan,
      requireOption(options, '--run'),
      await readJSON(requireOption(options, '--summary')),
      options['--analysis'] ? await readJSON(options['--analysis']) : null,
      requireOption(options, '--out'),
      options['--review'] ? await readJSON(options['--review']) : null,
      options['--evidence-kind'] ?? 'recorded-response'
    );
    console.log(
      JSON.stringify({
        offline: true,
        run: record.id,
        status: record.status,
        apiRequestsObserved: record.apiRequestsObserved,
      })
    );
    return;
  }
  if (command === 'review-template') {
    await writeOnce(
      requireOption(options, '--out'),
      reviewTemplate(plan, requireOption(options, '--run'))
    );
    return;
  }
  const records = await readRecords(requireOption(options, '--records'));
  const reviews = options['--reviews']
    ? await Promise.all(
        (await readdir(options['--reviews']))
          .filter((name) => name.endsWith('.json'))
          .map((name) => readJSON(path.join(options['--reviews'], name)))
      )
    : [];
  const report = comparisonReport(plan, records, reviews);
  await writeOnce(requireOption(options, '--out'), report);
  console.log(
    JSON.stringify({
      offline: true,
      fullGenerationsPlanned: report.fullGenerationsPlanned,
      settingsMatch: report.settingsMatch,
      variants: report.variants,
    })
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
