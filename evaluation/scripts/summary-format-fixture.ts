import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPageLayout } from '../../src/lib/pdf-layout';
import { sourceTableId } from '../../src/lib/source-provenance';
import { reviewCandidates, type Candidate } from '../../src/lib/fact-candidates';
import { parseFactSummary, renderFacts } from '../../src/lib/fact-summary';

/** Public PDF supplied by the user. Values/periods below are independently read from its cover. */
export async function summaryFormatFixture() {
  const pdf = new Uint8Array(await readFile('evaluation/fixtures/real-pdfs/kyokuto-20261005.pdf'));
  assert.equal(
    createHash('sha256').update(pdf).digest('hex'),
    '1a830c4c97addb7a4eb6f418eb45c444a326ea13f4e8bb7fb67a0f70391a5775',
    '固定した公開PDFと一致しません'
  );
  const document = await getDocument({ data: pdf.slice() }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n++)
    pages.push(await extractPdfPageLayout(await document.getPage(n), n, OPS));
  await document.destroy();
  const candidates: Candidate[] = [];
  const values: number[] = [];
  const add = (
    valueId: string,
    value: number,
    year: number,
    metricKind: 'amount' | 'rate' | 'perShare',
    forecast = false,
    dividend = false
  ) => {
    values.push(value);
    candidates.push({
      candidateId: `c${candidates.length + 1}`,
      importance: 'key',
      kind: 'number',
      source: {
        kind: 'table',
        valueId,
        tableId: sourceTableId(pages[0], valueId),
        contextBindingId: `ctx:${valueId}`,
      },
      meaning: {
        subject: '株式会社きょくとう',
        scope: dividend ? null : '非連結',
        basis: dividend ? null : '日本基準',
        period: `202${year}年2月期${!forecast && !dividend ? '第2四半期' : ''}`,
        periodKind: !forecast && !dividend ? 'cumulativeQ2' : 'fullYear',
        metricKind,
        state: forecast ? 'forecast' : 'actual',
        polarity: 'affirmative',
      },
    });
  };
  for (const [ids, amounts, year] of [
    [['p1s60', 'p1s64', 'p1s67', 'p1s70'], [2976, 247, 288, 207], 7],
    [['p1s75', 'p1s79', 'p1s82', 'p1s85'], [3130, 309, 355, 245], 6],
  ] as const)
    ids.forEach((id, i) => add(id, amounts[i], year, 'amount'));
  add('p1s101', 39.45, 7, 'perShare');
  add('p1s106', 46.66, 6, 'perShare');
  ['p1s206', 'p1s210', 'p1s212', 'p1s215'].forEach((id, i) =>
    add(id, [5350, 100, 180, 120][i], 7, 'amount', true)
  );
  add('p1s218', 22.8, 7, 'perShare', true);
  add('p1s174', 5.5, 7, 'perShare', false, true);
  add('p1s179', 5.5, 7, 'perShare', true, true);
  add('p1s181', 11, 7, 'perShare', true, true);
  for (const blockId of ['p1b31', 'p1b39'])
    candidates.push({
      candidateId: `c${candidates.length + 1}`,
      importance: 'key',
      kind: 'event',
      source: {
        kind: 'prose',
        blockId,
        assertionId: `${blockId}:a1`,
        quantityId: null,
        metric: null,
        contextBindingId: `ctx:${blockId}`,
      },
      meaning: {
        subject: '株式会社きょくとう',
        scope: blockId === 'p1b31' ? null : '非連結',
        basis: blockId === 'p1b31' ? null : '日本基準',
        period: null,
        periodKind: 'none',
        metricKind: 'none',
        state: 'unspecified',
        polarity: 'negative',
      },
    });
  const response = JSON.stringify({
    candidateVersion: 4,
    documentType: 'earnings',
    candidates,
    unverified: [],
  });
  const review = reviewCandidates(response, 'earnings', pages);
  assert.deepEqual(
    review.diagnostics.filter((d) => d.status !== 'valid'),
    []
  );
  assert.deepEqual(
    review.facts.filter((f) => f.kind === 'number').map((f) => f.value),
    values
  );
  const legacy = parseFactSummary(
    JSON.stringify({ version: 6, documentType: 'earnings', facts: review.facts, unverified: [] }),
    'earnings',
    pages
  );
  return {
    pdf,
    pages,
    documentType: 'earnings' as const,
    repairRequired: false,
    first: response,
    repair: response,
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [],
    expected: [
      '2976',
      '3130',
      '4.9%',
      '247',
      '309',
      '20.2%',
      '39.45',
      '46.66',
      '5350',
      '11',
      '季節',
      '変更なし',
      '確認事項',
      '対象期の表記が一致',
      '配当支払開始予定日',
      '2026年11月10日',
    ],
  };
}
