import { describe, expect, it } from 'vitest';
import cases from '../../evaluation/fixtures/real-pdf-cases.json';
import type { DocumentType } from './document-type';
import { detectDocumentType, detectEarningsContext } from './document-type';
import tables from './fixtures/reporting-table-corpus.json';
import { extractPageLayout } from './pdf-layout';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { CANDIDATE_VERSION, reviewCandidates, serializeCandidateSource } from './fact-candidates';
import { normalized, tableReferenceHints } from './document-structure';
import type { DrawingOperation } from './pdf-drawing';
import { verifyTableEvidence } from './numeric-evidence';
import { parseQuantity } from './quantity';
import { proseQuantities } from './quantity';
import { assertionId } from './source-provenance';
import { parseFactSummary, renderFacts } from './fact-summary';
import { validateSavedFacts } from './fact-cache';
import { verifyCoverage, coverageReport } from './fact-coverage';
import { preflightCandidateSource } from './source-preflight';
import { buildDocumentContext } from './document-context';
function proseEvent(
  blockId: string,
  candidateId: string,
  subject: string,
  scope: string | null,
  basis: string | null,
  state = 'unspecified',
  polarity = 'affirmative'
) {
  return {
    candidateId,
    importance: 'key',
    kind: 'event',
    source: {
      kind: 'prose',
      blockId,
      assertionId: assertionId(blockId),
      quantityId: null,
      metric: null,
      contextBindingId: `ctx:${blockId}`,
    },
    meaning: {
      subject,
      scope,
      basis,
      period: null,
      periodKind: 'none',
      metricKind: 'none',
      state,
      polarity,
    },
  };
}

describe('TDnet実PDFコーパスのタイトル分類', () => {
  it.each(cases)('$id $title', ({ title, expectedType }) => {
    expect(detectDocumentType(title)).toBe(expectedType as DocumentType);
  });

  it('全角表記のIFRS連結四半期コンテキストを判定する', () => {
    const earnings = cases.find((item) => item.id === '140120260709590576');
    expect(earnings).toBeDefined();
    expect(detectEarningsContext(earnings!.title)).toEqual({
      period: 'q1',
      accountingStandard: 'ifrs',
      isConsolidated: true,
    });
  });

  it('全角表記の日本基準連結中間期コンテキストを判定する', () => {
    const earnings = cases.find((item) => item.id === '140120260714592721');
    expect(earnings).toBeDefined();
    expect(detectEarningsContext(earnings!.title)).toEqual({
      period: 'q2',
      accountingStandard: 'jpGaap',
      isConsolidated: true,
    });
  });

  it.each([
    ['140120260714593346', 'q3', true],
    ['140120260708589925', 'fullYear', false],
    ['140120260713592617', 'q2', true],
  ] as const)('$0 の期区分と連結区分を判定する', (id, period, isConsolidated) => {
    const earnings = cases.find((item) => item.id === id);
    expect(earnings).toBeDefined();
    expect(detectEarningsContext(earnings!.title)).toEqual({
      period,
      accountingStandard: 'jpGaap',
      isConsolidated,
    });
  });

  it.each([
    ['140120260713592426', 'q2', 'ifrs', true],
    ['140120260713591990', 'fullYear', 'jpGaap', true],
    ['140120260713592047', 'q2', 'jpGaap', false],
  ] as const)(
    '$0 の追加決算コンテキストを判定する',
    (id, period, accountingStandard, isConsolidated) => {
      const earnings = cases.find((item) => item.id === id);
      expect(earnings).toBeDefined();
      expect(detectEarningsContext(earnings!.title)).toEqual({
        period,
        accountingStandard,
        isConsolidated,
      });
    }
  );
});

describe('原PDFから独立に固定した表紙の正常受理', () => {
  it.each(tables.filter((f) => 'forbiddenAnchors' in f))(
    '$id の包括利益注記を表本体へ貸さない',
    (fixture) => {
      const p = extractPageLayout(
        fixture.pages[0].items as TextItem[],
        1,
        fixture.pages[0].drawingOperations as DrawingOperation[]
      );
      const base = fixture.expected.find((e) => e.label === '営業利益')!;
      const valid = tableReferenceHints(p).find((h) => h.valueId === base.valueId)!;
      for (const valueId of fixture.forbiddenAnchors!) {
        expect(tableReferenceHints(p).some((h) => h.valueId === valueId)).toBe(false);
        const value = parseQuantity(p.quantities.find((q) => q.id === valueId)!.text)!.value;
        expect(() =>
          verifyTableEvidence(
            p,
            { ...valid, valueId },
            {
              label: base.label,
              value,
              unit: base.unit,
              period: base.period,
              valueKind: base.state,
            },
            false
          )
        ).toThrow('注記の数量');
      }
    }
  );
  it.each(tables)('$id の重要数値をモデル入力から選べて確定できる', (fixture) => {
    const pages = fixture.pages.map((p) =>
      extractPageLayout(
        p.items as TextItem[],
        p.pageNumber,
        p.drawingOperations as DrawingOperation[]
      )
    );
    const source = JSON.parse(serializeCandidateSource(pages));
    for (const expected of fixture.expected) {
      expect(source.unitContexts[expected.valueId], expected.valueId).toBeDefined();
      expect(
        source.pages[0].quantities.some((q: { id: string }) => q.id === expected.valueId)
      ).toBe(true);
      expect(
        source.pages[0].quantities.find((q: { id: string }) => q.id === expected.valueId)
          .eligibility
      ).toEqual({ status: 'selectable' });
    }
    const candidates = fixture.expected.map((expected, i) => ({
      candidateId: `c${i + 1}`,
      importance: 'key',
      kind: 'number',
      source: {
        kind: 'table',
        valueId: expected.valueId,
        tableId: source.pages[0].quantities.find((q: { id: string }) => q.id === expected.valueId)
          .tableId,
        contextBindingId: `ctx:${expected.valueId}`,
      },
      meaning: {
        subject: expected.subject,
        scope: expected.scope,
        basis: expected.basis,
        period:
          fixture.id === '140120260930543358'
            ? expected.period.replace(/累計$/, '')
            : expected.period,
        periodKind: expected.periodKind,
        metricKind: expected.metricKind,
        state: expected.state,
        polarity: 'affirmative',
      },
    }));
    const review = reviewCandidates(
      JSON.stringify({
        candidateVersion: CANDIDATE_VERSION,
        documentType: 'other',
        candidates,
        unverified: [],
      }),
      'other',
      pages
    );
    expect(review.unverified).toEqual([]);
    expect(
      review.facts.map((f) => [
        f.value,
        f.unit,
        normalized(f.label),
        f.semantics.state,
        f.semantics.periodKind,
      ])
    ).toEqual(
      fixture.expected.map((f) => [f.value, f.unit, normalized(f.label), f.state, f.periodKind])
    );
    const summary = {
      version: 5,
      documentType: 'other' as const,
      facts: review.facts,
      unverified: [],
    };
    validateSavedFacts(summary);
    expect(parseFactSummary(JSON.stringify(summary), 'other', pages)).toEqual(summary);
    if (fixture.id === '140120260930543358') {
      const events = reviewCandidates(
        JSON.stringify({
          candidateVersion: CANDIDATE_VERSION,
          documentType: 'earnings',
          candidates: [
            proseEvent(
              'p1b37',
              'c12',
              '株式会社エクスモーション',
              null,
              null,
              'unspecified',
              'negative'
            ),
            proseEvent(
              'p1b46',
              'c13',
              '株式会社エクスモーション',
              '連結',
              '日本基準',
              'unspecified',
              'negative'
            ),
          ],
          unverified: [],
        }),
        'earnings',
        pages
      );
      expect(events.unverified).toEqual([]);
      const complete = [...review.facts, ...events.facts];
      expect(() => verifyCoverage('earnings', pages, complete)).not.toThrow();
      for (const value of [160, 17.05, 206]) {
        expect(() =>
          verifyCoverage(
            'earnings',
            pages,
            complete.filter((f) => f.value !== value)
          )
        ).toThrow('COVERAGE:');
      }
      for (const [value, basis] of [
        [17.05, 'splitAdjusted'],
        [22.01, 'splitAdjusted'],
        [10, 'afterSplit'],
      ] as const) {
        const f = review.facts.find((f) => f.value === value)!;
        expect(f.provenance?.denominator?.value).toBe(1);
        expect(f.provenance?.adjustments.map((a) => a.basis)).toEqual([basis]);
      }
      expect(renderFacts(summary)).toContain('年間配当金合計は「－」');
      expect(renderFacts(summary)).toContain('2026年11月期第3四半期累計');
    }
  });
  it('IDECの本文配当は選択数量・1株の分母・予定と据置を同時に保持する', () => {
    const fixture = tables[0],
      p = extractPageLayout(
        fixture.pages[0].items as TextItem[],
        1,
        fixture.pages[0].drawingOperations as DrawingOperation[]
      );
    const b = p.blocks.find((b) => b.text.includes('中間配当金'))!;
    const candidates = [
      ['中間配当金', 65],
      ['期末配当金', 65],
      ['年間配当金', 130],
    ].map(([metric, value], i) => ({
      candidateId: `c${i + 1}`,
      importance: 'key',
      kind: 'number',
      source: {
        kind: 'prose',
        blockId: b.id,
        assertionId: assertionId(b.id),
        quantityId: proseQuantities(b).find((q) => parseQuantity(q.raw)?.value === value)!.id,
        metric,
        contextBindingId: `ctx:${b.id}`,
      },
      meaning: {
        subject: 'IDEC株式会社',
        scope: null,
        basis: null,
        period: '2027年3月期',
        periodKind: 'fullYear',
        metricKind: 'perShare',
        state: 'planned',
        polarity: 'mixed',
      },
    }));
    const r = reviewCandidates(
      JSON.stringify({
        candidateVersion: CANDIDATE_VERSION,
        documentType: 'other',
        candidates,
        unverified: [],
      }),
      'other',
      [p]
    );
    expect(r.unverified).toEqual([]);
    expect(
      r.facts.map((f) => [f.value, f.unit, f.semantics.state, f.provenance?.denominator?.proof])
    ).toEqual([
      [65, '円', 'planned', 'explicit'],
      [65, '円', 'planned', 'explicit'],
      [130, '円', 'planned', 'explicit'],
    ]);
    expect(r.facts.every((f) => f.quote === b.text)).toBe(true);
    const source = JSON.parse(serializeCandidateSource([p]));
    const tableCandidates = fixture.expected.map((e, i) => ({
      candidateId: `c${i + 4}`,
      importance: 'key',
      kind: 'number',
      source: {
        kind: 'table',
        valueId: e.valueId,
        tableId: source.pages[0].quantities.find((q: { id: string }) => q.id === e.valueId).tableId,
        contextBindingId: `ctx:${e.valueId}`,
      },
      meaning: {
        subject: e.subject,
        scope: e.scope,
        basis: e.basis,
        period: e.period,
        periodKind: e.periodKind,
        metricKind: e.metricKind,
        state: e.state,
        polarity: 'affirmative',
      },
    }));
    const complete = reviewCandidates(
      JSON.stringify({
        candidateVersion: CANDIDATE_VERSION,
        documentType: 'earningsRevision',
        candidates: [
          ...tableCandidates,
          ...candidates,
          proseEvent('p1b21', 'c14', 'IDEC株式会社', '連結', null, 'forecast'),
        ],
        unverified: [],
      }),
      'earningsRevision',
      [p]
    );
    expect(complete.unverified).toEqual([]);
    expect(() => verifyCoverage('earningsRevision', [p], complete.facts)).not.toThrow();
    expect(() =>
      verifyCoverage(
        'earningsRevision',
        [p],
        complete.facts.filter((f) => /^(売上高|営業利益)$/.test(f.label))
      )
    ).toThrow('ordinaryProfit');
    for (const value of [6000, 203.25, 130]) {
      expect(() =>
        verifyCoverage(
          'earningsRevision',
          [p],
          complete.facts.filter((f) => f.value !== value)
        )
      ).toThrow('COVERAGE:');
    }
    expect(() =>
      preflightCandidateSource(
        'earningsRevision',
        [p],
        buildDocumentContext([p]),
        serializeCandidateSource([p])
      )
    ).not.toThrow();
    const slots = coverageReport('earningsRevision', [p], []);
    expect(slots).toHaveLength(14);
    expect(slots.every((s) => s.sourceIds.length > 0)).toBe(true);
    const wrong = structuredClone(candidates[0]);
    wrong.source.quantityId = proseQuantities(b).find(
      (q) => parseQuantity(q.raw)?.value === 130
    )!.id;
    expect(
      reviewCandidates(
        JSON.stringify({
          candidateVersion: CANDIDATE_VERSION,
          documentType: 'other',
          candidates: [wrong],
          unverified: [],
        }),
        'other',
        [p]
      ).facts
    ).toEqual([]);
  });
});
