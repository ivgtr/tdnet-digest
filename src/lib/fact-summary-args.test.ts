import { it, expect } from 'vitest';
import { parseFactSummaryArgs } from '../../evaluation/scripts/fact-summary-args';

it.each([
  [[], null, false],
  [['--holdout'], null, true],
  [['--holdout', 'case', '--list-cases'], 'case', true],
  [['case', '--holdout'], 'case', true],
  [['--browser-module', '/module.mjs', '--browser', 'case'], 'case', false],
] as const)('フラグと値をケースIDとして選ばない: %j', (args, caseId, holdout) => {
  expect(parseFactSummaryArgs([...args])).toMatchObject({ caseId, holdout });
});
it.each(
  [
    ['--unknown'],
    ['--holdout', '--holdout'],
    ['a', 'b'],
    ['--browser-module'],
    ['--browser-module', '--holdout'],
  ].map((args) => ({ args }))
)('不明・重複・欠落したCLI引数を拒否する: $args', ({ args }) => {
  expect(() => parseFactSummaryArgs(args)).toThrow();
});
