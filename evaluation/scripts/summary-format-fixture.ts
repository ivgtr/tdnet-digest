import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPageLayout } from '../../src/lib/pdf-layout';
import { sourceTableId } from '../../src/lib/source-provenance';
import { reviewCandidates, type Candidate } from '../../src/lib/fact-candidates';
import { parseFactSummary, renderFacts } from '../../src/lib/fact-summary';

/** Public PDF supplied by the user. Values/periods below are independently read from its cover. */
async function publicPdf(company: string, sha256: string) {
  const pdf = new Uint8Array(
    await readFile(`evaluation/fixtures/real-pdfs/${company}-20261005.pdf`)
  );
  assert.equal(
    createHash('sha256').update(pdf).digest('hex'),
    sha256,
    '固定した公開PDFと一致しません'
  );
  const document = await getDocument({ data: pdf.slice() }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n++)
    pages.push(await extractPdfPageLayout(await document.getPage(n), n, OPS));
  await document.destroy();
  return { pdf, pages };
}

export async function summaryFormatFixture(company: 'kyokuto' | 'karura' = 'kyokuto') {
  const karura = company === 'karura';
  const subject = karura ? '株式会社カルラ' : '株式会社きょくとう';
  const scope = karura ? '連結' : '非連結';
  const { pdf, pages } = await publicPdf(
    company,
    karura
      ? 'a4f45c78c09fe947fe1a35ef03261031ed49d1f51af3d426b1691577caf5e701'
      : '1a830c4c97addb7a4eb6f418eb45c444a326ea13f4e8bb7fb67a0f70391a5775'
  );
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
        subject,
        scope: dividend ? null : scope,
        basis: dividend ? null : '日本基準',
        period: `202${year}年2月期${!forecast && !dividend ? '第2四半期' : ''}`,
        periodKind: !forecast && !dividend ? 'cumulativeQ2' : 'fullYear',
        metricKind,
        state: forecast ? 'forecast' : 'actual',
        polarity: 'affirmative',
      },
    });
  };
  for (const [ids, amounts, year] of karura
    ? ([
        [['p1s64', 'p1s68', 'p1s71', 'p1s74'], [3989, 211, 215, 83], 7],
        [['p1s79', 'p1s83', 'p1s86', 'p1s89'], [3935, 264, 262, 245], 6],
      ] as const)
    : ([
        [['p1s60', 'p1s64', 'p1s67', 'p1s70'], [2976, 247, 288, 207], 7],
        [['p1s75', 'p1s79', 'p1s82', 'p1s85'], [3130, 309, 355, 245], 6],
      ] as const))
    ids.forEach((id, i) => add(id, amounts[i], year, 'amount'));
  add(karura ? 'p1s119' : 'p1s101', karura ? 14.55 : 39.45, 7, 'perShare');
  add(karura ? 'p1s124' : 'p1s106', karura ? 42.56 : 46.66, 6, 'perShare');
  (karura
    ? ['p1s226', 'p1s230', 'p1s233', 'p1s236']
    : ['p1s206', 'p1s210', 'p1s212', 'p1s215']
  ).forEach((id, i) =>
    add(id, (karura ? [7700, 289, 289, 66] : [5350, 100, 180, 120])[i], 7, 'amount', true)
  );
  add(karura ? 'p1s239' : 'p1s218', karura ? 11.52 : 22.8, 7, 'perShare', true);
  if (!karura) add('p1s174', 5.5, 7, 'perShare', false, true);
  add(karura ? 'p1s196' : 'p1s179', karura ? 5 : 5.5, 7, 'perShare', true, true);
  add(karura ? 'p1s198' : 'p1s181', karura ? 5 : 11, 7, 'perShare', true, true);
  for (const blockId of karura ? ['p1b37', 'p1b45'] : ['p1b31', 'p1b39'])
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
        subject,
        scope: blockId === (karura ? 'p1b37' : 'p1b31') ? null : scope,
        basis: blockId === (karura ? 'p1b37' : 'p1b31') ? null : '日本基準',
        period: null,
        periodKind: 'none',
        metricKind: 'none',
        state: 'unspecified',
        polarity: karura && blockId === 'p1b45' ? 'affirmative' : 'negative',
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
    expected: karura
      ? [
          '3989',
          '3935',
          '211',
          '264',
          '215',
          '262',
          '83',
          '245',
          '7700',
          '11.52',
          '↑増収',
          '↓減益',
          '修正あり',
          '方向は本資料では未確認',
          '人件費',
          '原材料費',
        ]
      : [
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

/** Original current-only response must repair its omitted comparative reporting facts. */
export async function nachiSummaryFormatFixture(withPrevious = false) {
  const { pdf, pages } = await publicPdf(
    'nachi',
    'b8ac6a6a4ee91a4388f4d4f0ff88a0c133273930fe48e5b10901e4abd2727e46'
  );
  const candidates: Candidate[] = [];
  const values: number[] = [];
  const add = (
    valueId: string,
    value: number,
    year: number,
    metricKind: 'amount' | 'perShare',
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
        subject: '株式会社不二越',
        scope: dividend ? null : '連結',
        basis: dividend ? null : '日本基準',
        period: `${year}年11月期${!forecast && !dividend ? '第3四半期' : ''}`,
        periodKind: !forecast && !dividend ? 'cumulativeQ3' : 'fullYear',
        metricKind,
        state: forecast ? 'forecast' : 'actual',
        polarity: 'affirmative',
      },
    });
  };
  ['p1s46', 'p1s48', 'p1s50', 'p1s52'].forEach((id, i) =>
    add(id, [192326, 11457, 10873, 6629][i], 2026, 'amount')
  );
  add('p1s80', 304.28, 2026, 'perShare');
  ['p1s152', 'p1s154', 'p1s156', 'p1s158'].forEach((id, i) =>
    add(id, [255000, 15300, 13300, 7500][i], 2026, 'amount', true)
  );
  add('p1s160', 344.2, 2026, 'perShare', true);
  add('p1s130', 110, 2026, 'perShare', true, true);
  add('p1s131', 110, 2026, 'perShare', true, true);
  for (const blockId of ['p1b35', 'p1b43'])
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
        subject: '株式会社不二越',
        scope: blockId === 'p1b35' ? null : '連結',
        basis: blockId === 'p1b35' ? null : '日本基準',
        period: null,
        periodKind: 'none',
        metricKind: 'none',
        state: 'unspecified',
        polarity: 'negative',
      },
    });
  const initial = [...candidates];
  ['p1s55', 'p1s57', 'p1s59', 'p1s61'].forEach((id, i) =>
    add(id, [174194, 6628, 5141, 3640][i], 2025, 'amount')
  );
  add('p1s83', 161.29, 2025, 'perShare');
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
    repairRequired: !withPrevious,
    first: withPrevious
      ? response
      : JSON.stringify({
          candidateVersion: 4,
          documentType: 'earnings',
          candidates: initial,
          unverified: [],
        }),
    repair: JSON.stringify({
      candidateVersion: 4,
      documentType: 'earnings',
      candidates: candidates.slice(initial.length),
      unverified: [],
    }),
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [],
    expected: ['192326', '11457', '10873', '6629', '構造改革', '変更なし', '↑増収'],
  };
}

/** Fixed native PDF: valid rate facts must not replace amounts; repair appends four facts. */
export async function daisekiSummaryFormatFixture() {
  const { pdf, pages } = await publicPdf(
    'daiseki',
    '8e445ce9586fc2d5507bb7414d7bd4685eaee6543a806474533cc1b8fd4ca757'
  );
  const candidates: Candidate[] = [];
  const add = (
    valueId: string,
    year: number,
    metricKind: 'amount' | 'rate' | 'perShare',
    forecast = false,
    dividend = false
  ) => {
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
        subject: '株式会社ダイセキ',
        scope: dividend ? null : '連結',
        basis: dividend ? null : '日本基準',
        period: `${year}年2月期${!forecast && !dividend ? '第2四半期' : ''}`,
        periodKind: !forecast && !dividend ? 'cumulativeQ2' : 'fullYear',
        metricKind,
        state: forecast ? 'forecast' : 'actual',
        polarity: 'affirmative',
      },
    });
  };
  ['p1s63', 'p1s67', 'p1s71', 'p1s75'].forEach((id) => add(id, 2027, 'amount'));
  add('p1s127', 2027, 'perShare');
  ['p1s81', 'p1s85', 'p1s89', 'p1s93'].forEach((id) => add(id, 2026, 'amount'));
  add('p1s132', 2026, 'perShare');
  ['p1s237', 'p1s241'].forEach((id) => add(id, 2027, 'amount', true));
  add('p1s249', 2027, 'perShare', true);
  ['p1s205', 'p1s207'].forEach((id) => add(id, 2027, 'perShare', true, true));
  ['p1s235', 'p1s247'].forEach((id) => add(id, 2027, 'rate', true));
  const first = candidates.slice();
  ['p1s233', 'p1s245'].forEach((id) => add(id, 2027, 'amount', true));
  for (const blockId of ['p1b35', 'p4b14'])
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
        subject: '株式会社ダイセキ',
        scope: blockId === 'p1b35' ? null : '連結',
        basis: blockId === 'p1b35' ? null : '日本基準',
        period: null,
        periodKind: 'none',
        metricKind: 'none',
        state: 'unspecified',
        polarity: 'negative',
      },
    });
  const response = (items: Candidate[]) =>
    JSON.stringify({
      candidateVersion: 4,
      documentType: 'earnings',
      candidates: items,
      unverified: [],
    });
  const review = reviewCandidates(response(candidates), 'earnings', pages);
  assert.deepEqual(review.unverified, []);
  assert.equal(review.facts.length, 21);
  const legacy = parseFactSummary(
    JSON.stringify({ version: 6, documentType: 'earnings', facts: review.facts, unverified: [] }),
    'earnings',
    pages
  );
  return {
    pdf,
    pages,
    documentType: 'earnings' as const,
    repairRequired: true,
    first: response(first),
    repair: response(candidates.slice(first.length)),
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [],
    expected: ['74200', '11200', '変更なし', '37492', '36117'],
  };
}

export async function worldSummaryFormatFixture() {
  const { pdf, pages } = await publicPdf(
    'world',
    'a2957635486a22dedbea2c45f9698a29138eb8a4071da946740bb1506bfd031b'
  );
  const candidates: Candidate[] = [];
  const add = (
    page: number,
    valueId: string,
    year: number,
    eps = false,
    forecast = false,
    dividend = false
  ) => {
    candidates.push({
      candidateId: `c${candidates.length + 1}`,
      importance: 'key',
      kind: 'number',
      source: {
        kind: 'table',
        valueId,
        tableId: sourceTableId(pages[page - 1], valueId),
        contextBindingId: `ctx:${valueId}`,
      },
      meaning: {
        subject: '株式会社ワールド',
        scope: dividend ? null : '連結',
        basis: dividend ? null : 'IFRS',
        period: `${year}年2月期${forecast || dividend ? '' : '中間期'}`,
        periodKind: forecast || dividend ? 'fullYear' : 'cumulativeQ2',
        metricKind: eps || dividend ? 'perShare' : 'amount',
        state: forecast ? 'forecast' : 'actual',
        polarity: 'affirmative',
      },
    });
  };
  ['p1s50', 'p1s54', 'p1s58'].forEach((id) => add(1, id, 2027));
  add(1, 'p1s95', 2027, true);
  ['p1s61', 'p1s65', 'p1s69'].forEach((id) => add(1, id, 2026));
  add(1, 'p1s98', 2026, true);
  ['p2s23', 'p2s27', 'p2s31'].forEach((id) => add(2, id, 2027, false, true));
  add(2, 'p2s33', 2027, true, true);
  ['p1s147', 'p1s148'].forEach((id) => add(1, id, 2027, true, true, true));
  candidates.push({
    candidateId: `c${candidates.length + 1}`,
    importance: 'key',
    kind: 'event',
    source: {
      kind: 'prose',
      blockId: 'p1b37',
      assertionId: 'p1b37:a1',
      quantityId: null,
      metric: null,
      contextBindingId: 'ctx:p1b37',
    },
    meaning: {
      subject: '株式会社ワールド',
      scope: null,
      basis: null,
      period: null,
      periodKind: 'none',
      metricKind: 'none',
      state: 'unspecified',
      polarity: 'negative',
    },
  });
  const first = JSON.stringify({
    candidateVersion: 4,
    documentType: 'earnings',
    candidates,
    unverified: [],
  });
  const review = reviewCandidates(first, 'earnings', pages);
  assert.deepEqual(review.unverified, []);
  assert.equal(review.facts.length, 15);
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
    first,
    repair: first,
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [],
    expected: ['77.11', '82.74', '142489', '300000'],
  };
}

/** Public interim revision: all five before/after figures are independently read from p.1. */
export async function echoSummaryFormatFixture() {
  const { pdf, pages } = await publicPdf(
    'echo',
    'db4dae9bb3c06482d374f99c7a87ee8649f77e2f0d86220ecae68a9d78d7e8bb'
  );
  const candidates: Candidate[] = [];
  for (const [state, ids] of [
    ['forecastBefore', ['p1s78', 'p1s79', 'p1s80', 'p1s81', 'p1s82']],
    ['forecastAfter', ['p1s90', 'p1s91', 'p1s92', 'p1s93', 'p1s94']],
  ] as const) {
    ids.forEach((valueId, i) =>
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
          subject: 'エコートレーディング株式会社',
          scope: '連結',
          basis: null,
          period: '2027年2月期第2四半期',
          periodKind: 'cumulativeQ2',
          metricKind: i === 4 ? 'perShare' : 'amount',
          state,
          polarity: 'affirmative',
        },
      })
    );
  }
  for (const [blockId, polarity] of [
    ['p2b2', 'affirmative'],
    ['p2b3', 'affirmative'],
    ['p2b4', 'mixed'],
  ] as const)
    candidates.push({
      candidateId: `c${candidates.length + 1}`,
      importance: 'detail',
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
        subject: 'エコートレーディング株式会社',
        scope: null,
        basis: null,
        period: null,
        periodKind: 'none',
        metricKind: 'none',
        state: 'unspecified',
        polarity,
      },
    });
  const first = JSON.stringify({
    candidateVersion: 4,
    documentType: 'earningsRevision',
    candidates,
    unverified: [],
  });
  const review = reviewCandidates(first, 'earningsRevision', pages);
  assert.deepEqual(review.unverified, []);
  assert.equal(review.facts.length, 13);
  assert.deepEqual(
    review.facts.filter((f) => f.kind === 'number').map((f) => f.value),
    [54500, 555, 554, 371, 61.09, 55064, 330, 314, 187, 30.84]
  );
  const legacy = parseFactSummary(
    JSON.stringify({
      version: 6,
      documentType: 'earningsRevision',
      facts: review.facts,
      unverified: [],
    }),
    'earningsRevision',
    pages
  );
  return {
    pdf,
    pages,
    documentType: 'earningsRevision' as const,
    repairRequired: false,
    first,
    repair: first,
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [],
    expected: [
      '55064',
      '54500',
      '330',
      '555',
      '314',
      '554',
      '187',
      '371',
      '30.84',
      '61.09',
      '↑上方修正',
      '↓下方修正',
    ],
  };
}
