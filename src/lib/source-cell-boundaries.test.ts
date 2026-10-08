import { expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { extractPageLayout } from './pdf-layout';
import { buildBlocks, quantityCells, physicalCellOwners } from './document-structure';
import { buildTableCells, buildTableRegions } from './table-layout';
import { validatePages } from './fact-validation';
import { verifyTableEvidence } from './numeric-evidence';
import type { DrawingOperation } from './pdf-drawing';
import { numberCandidate } from './fixtures/v4-test-source';
import { candidateResponse } from './fixtures/candidate-test-source';
import { reviewCandidates } from './fact-candidates';
import { parseFactSummary } from './fact-summary';
import { bindLiteralQuantities, checkText, narrativeValues } from './summary-narrative';
import { renderNarrativeText } from './summary-narrative-renderer';
import { sourceInventory } from './summary-source-inventory';
import { buildDocumentContext, documentSubject } from './document-context';
import { earningsTarget } from './summary-earnings-policy';
import { buildPresentation, revalidatePresentation } from './summary-presentation';
import type { FactSummary } from './fact-contract';

function item(str: string, x: number, y: number, width = 15): TextItem {
  return {
    str,
    dir: 'ltr',
    transform: [10, 0, 0, 10, x, -y],
    width,
    height: 10,
    hasEOL: false,
    fontName: 'test',
  };
}
function closedGrid(xs: number[], top: number, bottom: number): DrawingOperation[] {
  const left = xs[0],
    right = xs[xs.length - 1];
  return [
    {
      index: 0,
      fn: 'constructPath',
      args: [
        'stroke',
        [
          [
            0,
            left,
            -top,
            1,
            right,
            -top,
            1,
            right,
            -bottom,
            1,
            left,
            -bottom,
            4,
            ...xs.slice(1, -1).flatMap((x) => [0, x, -top, 1, x, -bottom]),
          ],
        ],
        null,
      ],
    },
  ];
}

// This integration owns the actual drawing → metadata → confirmed headline boundary.
// Field vocabulary/ambiguity and cross-cell quantity rejection have separate tests.
it.each(['separate', 'mixed', 'wrapped'] as const)(
  '罫線で分かれた表紙欄を原文のまま保持し、正しい会社・範囲・基準で冒頭を復元する: %s',
  (layout) => {
    const fields = [
      ...(layout === 'mixed'
        ? [
            ['コード番号', '464A'],
            ['URL', 'https://example.com/report%20list'],
            ['上場取引所', '東'],
            ['代表者', '代表取締役社長', '山田太郎'],
          ]
        : []),
      ['会社名', '株式会社テスト'],
      ['会計基準', '日本基準'],
      ['範囲', '連結'],
    ];
    const items = [
      item(
        layout === 'separate' ? '2026年3月期 決算短信〔日本基準〕（連結）' : '2026年3月期 決算短信',
        0,
        10,
        400
      ),
    ];
    const operations: DrawingOperation[] = [];
    if (layout === 'mixed') {
      items.push(...fields.flat().map((text, i) => item(text, i * 120 + 10, 40, 100)));
      operations.push(
        ...closedGrid(
          Array.from({ length: fields.flat().length + 1 }, (_, i) => i * 120),
          30,
          50
        )
      );
    } else if (layout === 'wrapped') {
      fields.forEach(([label, value], i) => {
        items.push(item(`${label} ${value}`, 10, 40 + i * 18, 200));
        operations.push(...closedGrid([0, 250], 30 + i * 18, 48 + i * 18));
      });
    } else {
      fields.forEach(([label, value], i) => {
        items.push(item(label, 10, 40 + i * 30, 70), item(value, 110, 40 + i * 30, 130));
        operations.push(...closedGrid([0, 100, 300], 30 + i * 30, 50 + i * 30));
      });
    }
    operations.forEach((operation, i) => {
      operation.index = i;
    });
    items.push(
      item('2026年3月期 連結経営成績', 0, 140, 250),
      item('売上高は1,000百万円です。', 0, 170, 280)
    );
    const page = extractPageLayout(items, 1, operations);
    expect(() => validatePages([page])).not.toThrow();
    const originalFields =
      layout === 'separate'
        ? fields.map(([label, value]) => `${label} │ ${value}`)
        : layout === 'mixed'
          ? [fields.flat().join(' │ ')]
          : [fields.map(([label, value]) => `${label} ${value}`).join('\n│ ')];
    expect(page.blocks.slice(1, 1 + originalFields.length).map((block) => block.text)).toEqual(
      originalFields
    );
    const context = buildDocumentContext([page]);
    expect(documentSubject(context)).toBe('株式会社テスト');
    const excerpts = sourceInventory([page], context, 'earnings');
    expect(excerpts.map((excerpt) => excerpt.text)).toEqual(expect.arrayContaining(originalFields));
    expect(earningsTarget(excerpts)).toMatchObject({
      issue: null,
      target: {
        label: '2026年3月期',
        subject: '株式会社テスト',
        scope: '連結',
        basis: '日本基準',
      },
    });
    const reviewed = reviewCandidates(
      candidateResponse([numberCandidate(page, '売上高', 1000)], [page], 'earnings'),
      'earnings',
      [page]
    );
    expect(reviewed.unverified).toEqual([]);
    expect(reviewed.facts).toHaveLength(1);
    expect(reviewed.facts[0]).toMatchObject({
      value: 1000,
      semantics: { subject: '株式会社テスト', scope: '連結', basis: '日本基準' },
    });
    const summary: FactSummary = {
      version: 6,
      documentType: 'earnings',
      facts: reviewed.facts,
      unverified: [],
    };
    const display = buildPresentation(summary, [page]);
    expect(display.overview).toEqual([reviewed.facts[0].id]);
    // One representative restores confirmed facts against the original ruled source.
    if (layout === 'mixed') {
      const restored = parseFactSummary(JSON.stringify(summary), 'earnings', [page], false);
      expect(restored).toEqual(summary);
      expect(revalidatePresentation(JSON.parse(JSON.stringify(display)), restored, [page])).toEqual(
        display
      );
    }
  }
);

it.each(['empty-company-cell', 'unowned-value', 'ambiguous-owner'] as const)(
  '会社名欄は隣接する一意なセル以外の会社名を借りない: %s',
  (geometry) => {
    const items = [item('2026年3月期 決算短信〔日本基準〕（連結）', 0, 10, 400)];
    const operations: DrawingOperation[] = [];
    if (geometry === 'empty-company-cell') {
      items.push(
        item('項目', 10, 40, 60),
        item('当社', 110, 40, 60),
        item('参考会社', 210, 40, 80),
        item('会社名', 10, 70, 60),
        item('株式会社他社', 210, 70, 80)
      );
      operations.push(
        ...closedGrid([0, 100, 200, 300], 30, 50),
        ...closedGrid([0, 100, 200, 300], 60, 80)
      );
    } else {
      items.push(
        item('会社名', 10, 40, 40),
        item('株式会社他社', geometry === 'ambiguous-owner' ? 65 : 110, 40, 64)
      );
      operations.push(...closedGrid([0, 100], 30, 50));
      // The value belongs to two intersecting rectangles with no innermost cell.
      if (geometry === 'ambiguous-owner') operations.push(...closedGrid([95, 200], 25, 45));
    }
    operations.forEach((operation, i) => {
      operation.index = i;
    });
    items.push(
      item('2026年3月期 連結経営成績', 0, 100, 250),
      item('売上高は1,000百万円です。', 0, 140, 280)
    );
    const page = extractPageLayout(items, 1, operations);
    expect(() => validatePages([page])).not.toThrow();
    expect(page.blocks.find((block) => block.text.startsWith('会社名'))!.text).toBe(
      '会社名 ││ 株式会社他社'
    );
    const owners = physicalCellOwners(buildTableCells(page.drawingLines, page.spans, 1));
    const value = page.spans.find((span) => span.text === '株式会社他社')!;
    if (geometry === 'ambiguous-owner') expect(owners.get(value.id)).toBeNull();
    else if (geometry === 'unowned-value') expect(owners.has(value.id)).toBe(false);
    else expect(owners.get(value.id)).toMatchObject({ left: 200, right: 300 });
    const context = buildDocumentContext([page]);
    expect(documentSubject(context)).toBeNull();
    expect(earningsTarget(sourceInventory([page], context, 'earnings')).target).toMatchObject({
      subject: null,
      scope: '連結',
      basis: '日本基準',
    });
    const candidate = numberCandidate(page, '売上高', 1000);
    candidate.semantics.subject = '株式会社他社';
    const reviewed = reviewCandidates(
      candidateResponse([candidate], [page], 'earnings'),
      'earnings',
      [page]
    );
    expect(reviewed.facts).toEqual([]);
    expect(reviewed.unverified).toEqual([
      expect.stringContaining('SCOPE:subjectの適用根拠が不一致'),
    ]);
  }
);

it.each([
  { texts: ['100', '20'], gap: 1 },
  { texts: ['△', '10'], gap: 1 },
  { texts: ['3', ',963,389'], gap: 1 },
  { texts: ['100', '.20'], gap: 1 },
  { texts: ['100', '～200'], gap: 1 },
  { texts: ['10', '円', '00', '銭'], gap: 1 },
  { texts: ['10', '円', '00', '銭'], gap: 3 },
])('PDFアイテムと円銭の結合も閉じたセル境界を守る: $texts / $gap', ({ texts, gap }) => {
  const items = texts.map((text, i) => item(text, 10 + i * (15 + gap), 10));
  const splitAt = Math.floor(texts.length / 2);
  const boundary = 10 + splitAt * (15 + gap) - gap / 2;
  const whole = extractPageLayout(items, 1, closedGrid([0, 100], 0, 20));
  expect(whole.quantities.map((q) => q.text)).toEqual([texts.join('')]);
  const split = extractPageLayout(items, 1, closedGrid([0, boundary, 100], 0, 20));
  for (const span of split.spans) {
    const sides = span.sourceIds!.map((id) => Number(id.replace('p1i', '')) <= splitAt);
    expect(new Set(sides).size).toBe(1);
  }
  expect(split.quantities.some((q) => q.text === texts.join(''))).toBe(false);
  expect(() => validatePages([whole])).not.toThrow();
  expect(() => validatePages([split])).not.toThrow();
});

function amountPage(gap: number) {
  // This geometry admitted the valid-but-wrong 10020 in both validatePages and
  // verifyTableEvidence: its combined center still fitted the amount-unit band.
  return extractPageLayout(
    [
      item('2026年3月期 連結経営成績', 0, 10, 250),
      item('売上高', 100, 30, 40),
      item('百万円', 100, 50, 25),
      item('%', 138, 50, 8),
      item('2026年3月期', 0, 70, 80),
      item('100', 110, 70),
      item('20', 125 + gap, 70, 10),
    ],
    1,
    closedGrid([0, 95, 125 + gap / 2, 150], 35, 80)
  );
}

it.each([1, 4])('抽出から原文照合まで、別セルの100と20を独立した値に保つ: 間隔%s', (gap) => {
  const page = amountPage(gap);
  expect(page.quantities.map((q) => [q.id, q.text, q.spanIds])).toEqual([
    ['p1s6', '100', ['p1s6']],
    ['p1s7', '20', ['p1s7']],
  ]);
  expect(() => validatePages([page])).not.toThrow();
  const evidence = {
    valueId: 'p1s6',
    metricIds: ['p1s2'],
    periodIds: ['p1s5'],
    unitIds: ['p1s3'],
    contextIds: ['p1s1'],
  };
  const claim = {
    label: '売上高',
    value: 100,
    unit: '百万円',
    period: '2026年3月期',
    valueKind: 'actual' as const,
  };
  expect(verifyTableEvidence(page, evidence, claim).quote).toContain('\n100');
  expect(() => verifyTableEvidence(page, evidence, { ...claim, value: 10020 })).toThrow('値');
  // Keep the physical values even when the unit row cannot align every column.
  const empty: FactSummary = { version: 6, documentType: 'other', facts: [], unverified: [] };
  const display = buildPresentation(empty, [page]);
  expect(display.values.map((value) => [value.id, value.decimal, value.unit])).toEqual([
    ['p1s6', '100', null],
    ['p1s7', '20', null],
  ]);
  const sourceIds = display.excerpts.map((excerpt) => excerpt.id);
  expect(renderNarrativeText('{{value:p1s6}}、{{value:p1s7}}', display.values)).toBe('100、20');
  expect(() =>
    bindLiteralQuantities('20百万円', sourceIds, display.values, display.excerpts)
  ).toThrow('NARRATIVE_QUANTITY');
  const forged = structuredClone(page);
  forged.quantities = quantityCells(forged.spans);
  expect(forged.quantities.map((q) => q.text)).toEqual(['10020']);
  forged.tableRegions = buildTableRegions(forged);
  forged.blocks = buildBlocks(forged);
  expect(() => validatePages([forged])).toThrow('SOURCE:派生構造');
});

it('保存された派生spanでも原文字の別セル結合を検出する', () => {
  const forged = amountPage(1);
  const left = forged.spans.find((s) => s.id === 'p1s6')!;
  const right = forged.spans.find((s) => s.id === 'p1s7')!;
  left.text += right.text;
  left.sourceIds!.push(...right.sourceIds!);
  left.width = right.x + right.width - left.x;
  forged.spans = forged.spans.filter((s) => s !== right);
  forged.quantities = quantityCells(forged.spans);
  forged.tableRegions = buildTableRegions(forged);
  forged.blocks = buildBlocks(forged);
  expect(() => validatePages([forged])).toThrow('SOURCE:派生セルが原文字の物理セル境界');
});

it('曖昧なセルで分断された桁の接頭値を原文照合で確定しない', () => {
  const page = amountPage(4);
  page.spans.find((s) => s.id === 'p1s6')!.text = '3';
  page.spans.find((s) => s.id === 'p1s7')!.text = ',963,389';
  const cells = page.tableRegions[0].cells;
  const overlap = {
    id: 'overlap',
    left: 96,
    top: 30,
    right: 155,
    bottom: 85,
    spanIds: ['p1s6', 'p1s7'],
  };
  const evidence = {
    valueId: 'p1s6',
    metricIds: ['p1s2'],
    periodIds: ['p1s5'],
    unitIds: ['p1s3'],
    contextIds: ['p1s1'],
  };
  for (const membership of [
    [...cells, overlap],
    cells.filter((cell) => !cell.spanIds.includes('p1s7')),
  ]) {
    page.tableRegions[0].cells = membership;
    expect(() =>
      verifyTableEvidence(page, evidence, {
        label: '売上高',
        value: 3,
        unit: '百万円',
        period: '2026年3月期',
        valueKind: 'actual',
      })
    ).toThrow('値の参照先');
  }
});

// Ownership ambiguity belongs to that quantity, not every nearby numeric run.
// Exercise the drawing producer and canonical validation in both text orders.
it.each(
  (['before', 'after'] as const).flatMap((position) =>
    [
      ['20', '.5'],
      ['20.', '5'],
      ['20～', '25'],
    ].map((parts) => ({ position, parts }))
  )
)(
  '重なったセルの数量の$positionでも、一意な隣接セルの全数量を保持する: $parts',
  ({ position, parts }) => {
    const items =
      position === 'before'
        ? [item('100', 65, 40, 64), item(parts[0], 133, 40), item(parts[1], 152, 40)]
        : [item(parts[0], 50, 40), item(parts[1], 69, 40), item('100', 88, 40, 18)];
    const operations = [...closedGrid([0, 100], 30, 50), ...closedGrid([95, 200], 25, 45)];
    operations.forEach((operation, i) => {
      operation.index = i;
    });
    const page = extractPageLayout(items, 1, operations);
    const owners = physicalCellOwners(buildTableCells(page.drawingLines, page.spans, 1));
    const ambiguous = page.spans.find((span) => span.text === '100')!;
    const independent = page.spans.filter((span) => span !== ambiguous);
    expect(owners.get(ambiguous.id)).toBeNull();
    expect(independent.every((span) => !!owners.get(span.id))).toBe(true);
    expect(page.quantities.map((quantity) => [quantity.text, quantity.spanIds])).toEqual([
      [parts.join(''), independent.map((span) => span.id)],
    ]);
    expect(() => validatePages([page])).not.toThrow();
  }
);

it.each([
  ['20.', '5～'],
  ['1,', '00'],
])('隣接セル内の全断片が不完全なら短い数量を回復しない: %j', (...parts) => {
  const operations = [...closedGrid([0, 100], 30, 50), ...closedGrid([95, 200], 25, 45)];
  operations.forEach((operation, i) => {
    operation.index = i;
  });
  const page = extractPageLayout(
    [item('100', 65, 40, 64), item(parts[0], 133, 40), item(parts[1], 152, 40)],
    1,
    operations
  );
  const owners = physicalCellOwners(buildTableCells(page.drawingLines, page.spans, 1));
  expect(owners.get('p1s1')).toBeNull();
  expect(owners.get('p1s2')).toBeTruthy();
  expect(owners.get('p1s2')).toBe(owners.get('p1s3'));
  expect(page.quantities).toEqual([]);
});

it('重なったセルの隣でも未所属の数量は独立した閉じたセルとみなさない', () => {
  const operations = [...closedGrid([0, 100], 30, 50), ...closedGrid([95, 110], 25, 45)];
  operations.forEach((operation, i) => {
    operation.index = i;
  });
  const page = extractPageLayout([item('100', 65, 40, 64), item('20', 133, 40)], 1, operations);
  const owners = physicalCellOwners(buildTableCells(page.drawingLines, page.spans, 1));
  expect(owners.get('p1s1')).toBeNull();
  expect(owners.has('p1s2')).toBe(false);
  expect(page.quantities).toEqual([]);
});

it.each([
  ['100.', '20'],
  ['100', '～200'],
  ['100～', '200'],
])('重なったセルを含む小数・範囲断片は隣接する独立数量とみなさない: %j', (...texts) => {
  const operations = [...closedGrid([0, 100], 30, 50), ...closedGrid([95, 200], 25, 45)];
  operations.forEach((operation, i) => {
    operation.index = i;
  });
  const page = extractPageLayout(
    [item(texts[0], 65, 40, 64), item(texts[1], 133, 40)],
    1,
    operations
  );
  expect(page.quantities).toEqual([]);
  expect(() => validatePages([page])).not.toThrow();
});

it('別セルを繋いだ行の数字・単位を本文数量として確定せず、同一セルの本文は保つ', () => {
  const items = [
    item('会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結', 0, 10, 440),
    item('2026年3月期 連結経営成績', 0, 45, 250),
    item('売上高は', 40, 95, 42),
    item('100', 83, 95, 16),
    item('20', 101, 95, 15),
    item('百万円です。', 118, 95, 70),
  ];
  for (const split of [false, true]) {
    const page = extractPageLayout(
      items,
      1,
      closedGrid(split ? [0, 100, 117, 300] : [0, 300], 85, 105)
    );
    expect(() => validatePages([page])).not.toThrow();
    const fact = numberCandidate(page, '売上高', 10020);
    const candidate = reviewCandidates(candidateResponse([fact], [page]), 'other', [page]);
    if (!split) {
      expect(candidate.facts.map((f) => f.value)).toEqual([10020]);
      expect(() =>
        parseFactSummary(
          JSON.stringify({ version: 6, documentType: 'other', facts: [fact], unverified: [] }),
          'other',
          [page],
          false
        )
      ).not.toThrow();
    } else {
      expect(candidate.facts).toEqual([]);
      const empty: FactSummary = { version: 6, documentType: 'other', facts: [], unverified: [] };
      expect(narrativeValues(empty, [page], sourceInventory([page]))).toEqual([
        expect.objectContaining({ raw: '20', decimal: '20', unit: null }),
      ]);
      expect(page.blocks.find((block) => block.text.includes('売上高'))!.text).toBe(
        '売上高は100 │ 20 │ 百万円です。'
      );
      for (const value of [10020, 20]) {
        const saved = parseFactSummary(
          JSON.stringify({
            version: 6,
            documentType: 'other',
            facts: [{ ...fact, value }],
            unverified: [],
          }),
          'other',
          [page],
          false
        );
        expect(saved.facts).toEqual([]);
        expect(saved.unverified.length).toBeGreaterThan(0);
      }
    }
  }
});

it('別セルの改行で負号を借りず、同一セルの折返しだけを負数として確定する', () => {
  const items = [
    item('会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結', 0, 10, 440),
    item('2026年3月期 連結経営成績', 0, 45, 250),
    item('営業利益は△', 40, 95, 140),
    item('10百万円です。', 40, 110, 140),
  ];
  const operations = closedGrid([0, 300], 85, 120);
  operations[0].args[1] = [[...(operations[0].args[1] as number[][])[0], 0, 0, -100, 1, 300, -100]];
  const separate = extractPageLayout(items, 1, operations);
  expect(separate.blocks[2].text).toBe('営業利益は△\n│ 10百万円です。');
  const whole = extractPageLayout(items, 1, closedGrid([0, 300], 85, 120));
  expect(whole.blocks[2].text).toBe('営業利益は△\n10百万円です。');
  for (const [page, values] of [
    [whole, [-10]],
    [separate, []],
  ] as const) {
    const fact = numberCandidate(page, '営業利益', -10);
    const result = reviewCandidates(candidateResponse([fact], [page]), 'other', [page]);
    expect(result.facts.map((f) => f.value)).toEqual(values);
  }
});

it('表示数量も別セルの隣接単位を借りず、同一セルの分割単位だけを結合する', () => {
  const empty: FactSummary = { version: 6, documentType: 'other', facts: [], unverified: [] };
  for (const split of [false, true]) {
    const page = extractPageLayout(
      [item('100', 40, 95, 16), item('百万円', 58, 95, 30)],
      1,
      closedGrid(split ? [0, 57, 100] : [0, 100], 85, 105)
    );
    const values = narrativeValues(empty, [page], sourceInventory([page]));
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((value) => value.decimal === '100')).toBe(true);
    expect(values.every((value) => value.unit === (split ? null : '百万円'))).toBe(true);
  }
});

it('セル境界を含む行でも同一の表示数量を本文IDで重複登録しない', () => {
  const page = extractPageLayout(
    [item('100百万円', 40, 95, 60), item('20%', 104, 95, 30)],
    1,
    closedGrid([0, 102, 150], 85, 105)
  );
  const empty: FactSummary = { version: 6, documentType: 'other', facts: [], unverified: [] };
  const display = buildPresentation(empty, [page]);
  expect(display.values.map((value) => [value.id, value.raw, value.unit])).toEqual([
    ['p1s1', '100百万円', '百万円'],
    ['p1s2', '20%', '%'],
  ]);
  const sourceIds = display.excerpts.map((excerpt) => excerpt.id);
  const bound = bindLiteralQuantities(
    '売上高100百万円、比率20%。',
    sourceIds,
    display.values,
    display.excerpts
  );
  expect(bound).toBe('売上高{{value:p1s1}}、比率{{value:p1s2}}。');
  expect(() => checkText(bound, sourceIds, display.values, display.excerpts, empty)).not.toThrow();
  expect(renderNarrativeText(bound, display.values)).toBe('売上高100百万円、比率20%。');
  for (const invalid of ['10020百万円', '20百万円']) {
    expect(() =>
      bindLiteralQuantities(invalid, sourceIds, display.values, display.excerpts)
    ).toThrow('NARRATIVE_QUANTITY');
  }
});

it.each(['same-cell', 'unruled', 'unowned-neighbor', 'ambiguous-neighbor'] as const)(
  '独立したセルと証明できない本文断片の数量を短い表示値として公開しない: %s',
  (geometry) => {
    const operations =
      geometry === 'unruled'
        ? []
        : geometry === 'same-cell'
          ? closedGrid([0, 150], 30, 50)
          : closedGrid([0, 100], 30, 50);
    if (geometry === 'ambiguous-neighbor') operations.push(...closedGrid([95, 200], 25, 45));
    operations.forEach((operation, i) => {
      operation.index = i;
    });
    const page = extractPageLayout(
      [
        item('100', 75, 40),
        item('億27百万円', 94, 40, geometry === 'ambiguous-neighbor' ? 10 : 24),
      ],
      1,
      operations
    );
    const owners = physicalCellOwners(buildTableCells(page.drawingLines, page.spans, 1));
    if (geometry === 'same-cell') expect(owners.get('p1s1')).toBe(owners.get('p1s2'));
    else if (geometry === 'unruled') expect(owners.size).toBe(0);
    else {
      expect(owners.get('p1s1')).toBeTruthy();
      if (geometry === 'ambiguous-neighbor') expect(owners.get('p1s2')).toBeNull();
      else expect(owners.has('p1s2')).toBe(false);
    }
    // The producer's scalar is deliberately present: its consumer must still
    // reject the partial expression, even across an unresolved cell boundary.
    expect(page.quantities.map((quantity) => quantity.text)).toEqual(['100']);
    const empty: FactSummary = { version: 6, documentType: 'other', facts: [], unverified: [] };
    const values = buildPresentation(empty, [page]).values;
    expect(values.some((value) => value.decimal === '100')).toBe(false);
    expect(values.map((value) => value.raw)).toEqual(
      geometry === 'same-cell' || geometry === 'unruled' ? ['100億27百万円'] : []
    );
  }
);
