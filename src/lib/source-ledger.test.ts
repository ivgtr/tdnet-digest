import { describe, expect, it } from 'vitest';
import { canonicalJSON, hashText } from './fact-contract';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { extractPageLayout } from './pdf-layout';
import { textPage } from './fixtures/v4-test-source';
import {
  buildSourceLedger,
  sourceLedgerModelInput,
  projectSourceModelInput,
  validateSourceLedger,
  unrepresentedSourceItems,
  type SourceLedger,
} from './source-ledger';

function source() {
  const page = textPage(
    '問合せ先 電話 03-1234-5678\n未知の指標 区分Ａ\n１２３ 不明単位\n未分類の説明'
  );
  const first = page.spans[0];
  page.quantities = [{ ...first, spanIds: [first.id] }];
  page.tableRegions = [
    {
      id: 'p1t1',
      method: 'ruled',
      spanIds: page.spans.map((s) => s.id),
      valueIds: [first.id],
      unitIds: [page.spans[1].id],
      ruleIds: [],
      top: -900,
      bottom: 0,
      cells: page.spans.map((s, i) => ({
        id: `p1t1c${i}`,
        left: s.x,
        top: s.y - s.height,
        right: s.x + s.width,
        bottom: s.y,
        spanIds: [s.id],
      })),
    },
  ];
  // A source span can survive even when no paragraph/row owns it.
  page.blocks = page.blocks.slice(0, -1);
  page.blocks.push({
    id: 'p1empty',
    page: 1,
    kind: 'paragraph',
    text: '',
    spanIds: [],
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  });
  page.selection = 'omitted';
  const empty = textPage('', 2);
  empty.status = 'empty';
  const failed = textPage('', 3);
  failed.status = 'failed';
  return [page, empty, failed];
}
const copy = (v: SourceLedger): SourceLedger => JSON.parse(JSON.stringify(v));
function rehash(v: SourceLedger) {
  v.sourceHash = hashText(canonicalJSON({ version: v.version, pages: v.pages, rows: v.rows }));
  return v;
}

describe('source ledger (raw retention and integrity, not semantic verification)', () => {
  it('retains unrecognized/admin/blank rows, all spans, source items, table headers/cells and page states', () => {
    const pages = source(),
      before = JSON.stringify(pages),
      ledger = buildSourceLedger(pages);
    expect(ledger.rows.map((r) => [r.id, r.text, r.spanIds])).toEqual(
      pages.flatMap((p) => p.blocks.map((b) => [b.id, b.text, b.spanIds]))
    );
    expect(ledger.pages.map((p) => [p.status, p.selection])).toEqual(
      pages.map((p) => [p.status, p.selection])
    );
    expect(ledger.pages[0].spans.map((s) => s.text)).toEqual(pages[0].spans.map((s) => s.text));
    expect(ledger.pages[0].sourceItems.map((s) => s.text)).toEqual(
      pages[0].sourceItems.map((s) => s.text)
    );
    expect(ledger.pages[0].tables[0].cells.map((c) => c.spanIds)).toEqual(
      pages[0].tableRegions[0].cells.map((c) => c.spanIds)
    );
    expect(ledger.pages[0].tables[0].unitIds).toEqual(pages[0].tableRegions[0].unitIds);
    expect(ledger.pages[0].quantities[0]).toMatchObject({
      text: pages[0].quantities[0].text,
      unit: null,
    });
    expect(JSON.stringify(pages)).toBe(before);
    expect(Object.isFrozen(ledger.rows[0].spanIds)).toBe(true);
    pages[0].blocks[0].text = 'changed externally';
    expect(ledger.rows[0].text).not.toBe('changed externally');
  });

  it('keeps loose spans and every physical page in the model view without semantic claims', () => {
    const ledger = buildSourceLedger(source()),
      input = sourceLedgerModelInput(ledger);
    expect(input.coverage.rows).toBe(ledger.rows.length);
    expect(input.pages.map((p) => p.status)).toEqual(['ok', 'empty', 'failed']);
    for (const p of input.pages) {
      const ids = new Set([
        ...p.rows.flatMap((r) => r[2].map((c) => c[0])),
        ...p.looseSpans.map((s) => s[0]),
      ]);
      expect([...ids].sort()).toEqual(
        ledger.pages
          .find((x) => x.pageNumber === p.pageNumber)!
          .spans.map((s) => s.id)
          .sort()
      );
    }
    expect(input.pages[0].looseSpans.length).toBeGreaterThan(0);
    expect(input.pages[0].tables[0][4]).toEqual(ledger.pages[0].tables[0].spanIds);
    expect(JSON.stringify(input)).not.toMatch(/semanticsVerified|numericVerified/);
    Object.assign(input.pages[0], { secret: 'not persisted' });
    expect(projectSourceModelInput(input).pages[0]).not.toHaveProperty('secret');
  });

  it('uses the explicit document type for hints while retaining identical source rows', () => {
    const pages = [textPage('1. 経営成績\n売上高は増加した。')];
    const earnings = buildSourceLedger(pages, 'earnings');
    const other = buildSourceLedger(pages);
    expect(earnings.rows[0].marks.role).toBe('performance');
    expect(other.rows[0].marks.role).toBe('content');
    expect(earnings.pages).toEqual(other.pages);
    expect(earnings.rows.map(({ marks: _marks, ...row }) => row)).toEqual(
      other.rows.map(({ marks: _marks, ...row }) => row)
    );
  });

  it('projects rotated native originals by provenance even when horizontal text is identical', () => {
    const item = (str: string, rotated: boolean, y: number): TextItem => ({
      str,
      dir: 'ltr',
      transform: rotated ? [0, 10, -10, 0, 0, y] : [10, 0, 0, 10, 0, y],
      width: str.length * 10,
      height: 10,
      hasEOL: true,
      fontName: 'test',
    });
    const page = extractPageLayout(
      [
        item('同一の注記', false, 800),
        item('同一の注記', true, 760),
        item('  回転した限定条件  ', true, 720),
        item('   ', false, 680),
      ],
      1
    );
    expect(page.text).toContain('回転した限定条件');
    expect(page.sourceItems.map((s) => s.id)).toEqual(['p1i1', 'p1i2', 'p1i3', 'p1i4']);
    const ledger = buildSourceLedger([page]);
    const originals = unrepresentedSourceItems(ledger.pages[0]);
    expect(originals.map((s) => [s.id, s.text])).toEqual([
      ['p1i2', '同一の注記'],
      ['p1i3', '  回転した限定条件  '],
    ]);
    const input = sourceLedgerModelInput(ledger);
    expect(input.pages[0].originalItems.map((s) => s.slice(0, 2))).toEqual(
      originals.map((s) => [s.id, s.text])
    );
    expect(input.columns.originalItems).toEqual(['sourceItemId', 'text', 'x', 'y']);
    Object.assign(input.pages[0].originalItems[0], { secret: 'not persisted' });
    input.pages[0].originalItems[0].push('hidden' as never);
    const projected = projectSourceModelInput(input);
    expect(projected.pages[0].originalItems[0]).toHaveLength(4);
    expect(projected.pages[0].originalItems[0]).not.toHaveProperty('secret');
    expect(JSON.stringify(projected)).not.toContain('hidden');
  });

  it('checks claimed item text coverage and does not repeat fully represented joined or split items', () => {
    const page = textPage('第一原文\n第二原文\n一部が失われた原文');
    const ledger = copy(buildSourceLedger([page]));
    const p = ledger.pages[0];
    p.spans = [
      { ...p.spans[0], text: '第一原文第二原文', sourceIds: ['p1i1', 'p1i2'] },
      { ...p.spans[2], text: '一部', sourceIds: ['p1i3'] },
    ];
    expect(unrepresentedSourceItems(p).map((s) => s.id)).toEqual(['p1i3']);
    p.spans.push({ ...p.spans[1], id: 'p1split', text: 'が失われた原文' });
    expect(unrepresentedSourceItems(p)).toEqual([]);
    // Equal originals inside one merged span still need separate occurrences.
    p.sourceItems[1].text = '第一原文';
    p.spans[0].text = '第一原文';
    expect(unrepresentedSourceItems(p).map((s) => s.id)).toContain('p1i2');
  });

  it('adds only empty original-item lists for normal multi-page text rather than duplicating source items', () => {
    const pages = Array.from({ length: 26 }, (_, i) =>
      textPage(
        Array.from({ length: 30 }, (_, j) => `区分${j} 原文の説明と注記をそのまま保持する。`).join(
          '\n'
        ),
        i + 1
      )
    );
    const input = sourceLedgerModelInput(buildSourceLedger(pages));
    expect(input.pages.every((p) => p.originalItems.length === 0)).toBe(true);
    const before = JSON.stringify({
      ...input,
      pages: input.pages.map(({ originalItems: _items, ...p }) => p),
    });
    expect(JSON.stringify(input).length - before.length).toBeLessThan(600);
  });

  it('round trips canonical JSON, hashing source order, marks, states and exact text', () => {
    const ledger = buildSourceLedger(source());
    expect(validateSourceLedger(JSON.parse(canonicalJSON(ledger)))).toEqual(ledger);
    const mutations: Array<(l: SourceLedger) => void> = [
      (l) => {
        l.rows[0].text += ' ';
      },
      (l) => {
        l.rows.reverse();
      },
      (l) => {
        l.rows[0].marks.role = 'impact';
      },
      (l) => {
        l.pages[1].status = 'failed';
      },
      (l) => {
        l.pages[0].selection = 'selected';
      },
      (l) => {
        l.pages[0].spans[0].text += ' ';
      },
      (l) => {
        l.pages[0].tables[0].cells.reverse();
      },
    ];
    for (const mutate of mutations) {
      const changed = copy(ledger);
      mutate(changed);
      expect(() => validateSourceLedger(changed)).toThrow(/SOURCE_LEDGER/);
    }
  });

  it('rejects duplicate identities and dangling references even with a recomputed hash', () => {
    const ledger = buildSourceLedger(source());
    const mutations: Array<(l: SourceLedger) => void> = [
      (l) => {
        l.pages.push(l.pages[0]);
      },
      (l) => {
        l.rows.push(l.rows[0]);
      },
      (l) => {
        l.pages[0].spans.push(l.pages[0].spans[0]);
      },
      (l) => {
        l.pages[0].sourceItems.push(l.pages[0].sourceItems[0]);
      },
      (l) => {
        l.pages[0].quantities.push(l.pages[0].quantities[0]);
      },
      (l) => {
        l.pages[0].tables.push(l.pages[0].tables[0]);
      },
      (l) => {
        l.pages[0].tables[0].cells.push(l.pages[0].tables[0].cells[0]);
      },
      (l) => {
        l.rows[0].spanIds = ['missing'];
      },
      (l) => {
        l.rows[0].page = 99;
      },
      (l) => {
        l.rows[0].marks.headingId = 'missing';
      },
      (l) => {
        l.pages[0].spans[0].sourceIds = ['missing'];
      },
      (l) => {
        l.pages[0].quantities[0].spanIds = ['missing'];
      },
      (l) => {
        l.pages[0].tables[0].valueIds = ['missing'];
      },
      (l) => {
        l.pages[0].tables[0].unitIds = ['missing'];
      },
      (l) => {
        l.pages[0].tables[0].spanIds = [];
      },
      (l) => {
        l.pages[0].tables[0].cells[0].spanIds = ['missing'];
      },
    ];
    mutations.push((l) => {
      l.rows[0].id = l.pages[0].spans[0].id;
      l.rows[0].marks.headingId = null;
    });
    for (const mutate of mutations) {
      const changed = copy(ledger);
      mutate(changed);
      expect(() => validateSourceLedger(rehash(changed))).toThrow(/SOURCE_LEDGER/);
    }
  });

  it('rejects malformed/extra properties and nonfinite geometry without accepting a semantic unit', () => {
    const ledger = buildSourceLedger(source());
    for (const malformed of [null, [], {}, { ...ledger, verified: true }]) {
      expect(() => validateSourceLedger(malformed)).toThrow(/SOURCE_LEDGER/);
    }
    const nonfinite = copy(ledger);
    nonfinite.pages[0].spans[0].box[0] = Infinity;
    expect(() => validateSourceLedger(rehash(nonfinite))).toThrow(/SOURCE_LEDGER/);
    const unit = copy(ledger);
    Object.assign(unit.pages[0].quantities[0], { unit: '百万円' });
    expect(() => validateSourceLedger(rehash(unit))).toThrow(/SOURCE_LEDGER/);
  });
});
