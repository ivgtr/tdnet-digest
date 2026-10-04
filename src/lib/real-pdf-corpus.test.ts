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
import { stableFactId } from './fact-contract';
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
  it.each([
    ['140120260713591990', 'earnings'],
    ['140120260714593203', 'earningsRevision'],
    ['holdout-insource-20260924', 'earningsRevision'],
  ] as const)('既知の反例 %s は代表指標だけでなく通常生成前の根拠検査も通る', (id, type) => {
    const fixture = tables.find((f) => f.id === id)!;
    const pages = fixture.pages.map((p) =>
      extractPageLayout(
        p.items as TextItem[],
        p.pageNumber,
        p.drawingOperations as DrawingOperation[]
      )
    );
    const context = buildDocumentContext(pages);
    const source = serializeCandidateSource(pages, context, type);
    expect(() => preflightCandidateSource(type, pages, context, source)).not.toThrow();
  });
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
      kind: expected.value === null ? 'range' : 'number',
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
        ...(f.kind === 'range' && f.quantity && 'lower' in f.quantity
          ? [f.quantity.lower, f.quantity.upper]
          : []),
      ])
    ).toEqual(
      fixture.expected.map((f) => [
        f.value,
        f.unit,
        normalized(f.label),
        f.state,
        f.periodKind,
        ...('lower' in f ? [f.lower, f.upper] : []),
      ])
    );
    const summary = {
      version: 5,
      documentType: 'other' as const,
      facts: review.facts,
      unverified: [],
    };
    validateSavedFacts(summary);
    expect(parseFactSummary(JSON.stringify(summary), 'other', pages)).toEqual(summary);
    if (fixture.id === 'holdout-remix-20260611') {
      const context = buildDocumentContext(pages);
      expect(() =>
        preflightCandidateSource(
          'earningsRevision',
          pages,
          context,
          serializeCandidateSource(pages, context, 'earningsRevision')
        )
      ).not.toThrow();
      const slots = coverageReport('earningsRevision', pages, review.facts, [], context);
      expect(slots).toHaveLength(10);
      expect(slots.every((s) => s.status === 'satisfied')).toBe(true);
      const lostMapping = {
        ...context,
        tableMappings: context.tableMappings.filter((h) => h.valueId !== 'p1s61'),
      };
      expect(coverageReport('earningsRevision', pages, [], [], lostMapping)).toHaveLength(10);
      expect(() =>
        preflightCandidateSource(
          'earningsRevision',
          pages,
          lostMapping,
          serializeCandidateSource(pages, lostMapping, 'earningsRevision')
        )
      ).toThrow('1株当たり利益');
      for (const state of ['actual', 'forecast', 'all'] as const) {
        const lostIds = fixture.expected
          .filter((f) => state === 'all' || f.state === state)
          .map((f) => f.valueId);
        const lostGroup = {
          ...context,
          tableMappings: context.tableMappings.filter((h) => !lostIds.includes(h.valueId)),
        };
        const remainingFacts = review.facts.filter(
          (f) => state !== 'all' && f.semantics.state !== state
        );
        const obligations = coverageReport(
          'earningsRevision',
          pages,
          remainingFacts,
          [],
          lostGroup
        );
        expect(obligations).toHaveLength(10);
        expect(obligations.filter((s) => s.status !== 'satisfied')).toHaveLength(lostIds.length);
        expect(() => verifyCoverage('earningsRevision', pages, remainingFacts, lostGroup)).toThrow(
          'COVERAGE'
        );
        expect(() =>
          preflightCandidateSource(
            'earningsRevision',
            pages,
            lostGroup,
            serializeCandidateSource(pages, lostGroup, 'earningsRevision')
          )
        ).toThrow('SOURCE_PREFLIGHT');
      }
      for (const fact of review.facts) {
        expect(
          coverageReport(
            'earningsRevision',
            pages,
            review.facts.filter((f) => f.id !== fact.id),
            [],
            context
          ).filter((s) => s.status !== 'satisfied')
        ).toHaveLength(1);
      }
      const wrong = structuredClone(
        candidates.filter((c) => c.source.valueId === 'p1s57' || c.source.valueId === 'p1s63')
      );
      wrong[0].meaning.state = 'forecast';
      wrong[1].meaning.state = 'forecastAfter';
      expect(
        reviewCandidates(
          JSON.stringify({
            candidateVersion: 3,
            documentType: 'earningsRevision',
            candidates: wrong,
            unverified: [],
          }),
          'earningsRevision',
          pages
        ).facts
      ).toEqual([]);
      for (const fact of review.facts.filter(
        (f) => f.evidence.kind === 'table' && ['p1s57', 'p1s63'].includes(f.evidence.valueId)
      )) {
        const forged = structuredClone(fact);
        forged.semantics.state = forged.valueKind =
          fact.semantics.state === 'actual' ? 'forecast' : 'forecastAfter';
        forged.id = stableFactId(forged);
        expect(
          parseFactSummary(JSON.stringify({ ...summary, facts: [forged] }), 'other', pages, false)
            .facts
        ).toEqual([]);
      }
    }
    if (fixture.id === 'holdout-makuake-20260901') {
      const ranges = review.facts.filter((f) => f.kind === 'range');
      expect(ranges).toHaveLength(4);
      for (const f of ranges) {
        expect(f.semantics.state).toBe('forecastBefore');
        expect(f.valueKind).toBe('forecastBefore');
        expect(f.quantity!.raw).toContain('\n');
        expect(f.quantity!.sourceIds.length).toBeGreaterThan(1);
        expect(renderFacts(summary)).toContain(
          f.quantity && 'lower' in f.quantity
            ? `${f.quantity.lower}～${f.quantity.upper}${f.unit}`
            : 'missing range'
        );
        const source = candidates.find(
          (c) => c.source.valueId === (f.evidence.kind === 'table' ? f.evidence.valueId : null)
        )!;
        const wrong = reviewCandidates(
          JSON.stringify({
            candidateVersion: 3,
            documentType: 'other',
            candidates: [{ ...source, kind: 'number' }],
            unverified: [],
          }),
          'other',
          pages
        );
        expect(wrong.facts).toEqual([]);
        expect(wrong.unverified.join(' ')).toContain('QUANTITY');
      }
      const original = ranges.find((f) => normalized(f.label) === '営業利益')!;
      const invalidItems = structuredClone(fixture.pages[0].items) as TextItem[];
      invalidItems.find((item) => item.str === '670')!.str = '900';
      const invalidPages = [
        extractPageLayout(
          invalidItems,
          1,
          fixture.pages[0].drawingOperations as DrawingOperation[]
        ),
        ...pages.slice(1),
      ];
      const invalidContext = buildDocumentContext(invalidPages);
      const invalidInput = serializeCandidateSource(
        invalidPages,
        invalidContext,
        'earningsRevision'
      );
      expect(
        JSON.parse(invalidInput).pages[0].quantities.find((q: { id: string }) => q.id === 'p1s67')
          .eligibility.status
      ).toBe('blocked');
      expect(() =>
        preflightCandidateSource('earningsRevision', invalidPages, invalidContext, invalidInput)
      ).toThrow('断片が未解決');
      // Removing the physical boundaries does not license reading one endpoint
      // as the whole quantity. Keep the text and report unresolved structure.
      const unruled = [
        extractPageLayout(fixture.pages[0].items as TextItem[], 1),
        ...pages.slice(1),
      ];
      const unruledContext = buildDocumentContext(unruled);
      const unruledInput = serializeCandidateSource(unruled, unruledContext, 'earningsRevision');
      expect(() =>
        preflightCandidateSource('earningsRevision', unruled, unruledContext, unruledInput)
      ).toThrow('断片が未解決');
      for (const value of [670, 800, 735]) {
        const forged = structuredClone(original);
        forged.kind = 'number';
        forged.value = value;
        forged.quantity = {
          raw: String(value),
          decimal: String(value),
          sourceIds: original.quantity!.sourceIds,
        };
        forged.id = stableFactId(forged);
        expect(() =>
          parseFactSummary(JSON.stringify({ ...summary, facts: [forged] }), 'other', pages)
        ).toThrow('値・符号');
      }
      const slots = coverageReport('earningsRevision', pages, [], [], buildDocumentContext(pages));
      expect(slots.filter((s) => s.expected.kind === 'range')).toHaveLength(4);
      expect(
        coverageReport('earningsRevision', pages, review.facts)
          .filter((s) => /予想修正の前後/.test(s.requirement))
          .every((s) => s.status === 'satisfied')
      ).toBe(true);
    }
    if (fixture.id === 'holdout-insource-20260924') {
      const block = pages[0].blocks.find((b) => b.id === 'p1b25')!;
      const quantity = proseQuantities(block).find((q) => parseQuantity(q.raw)?.value === 35)!;
      const dividend = {
        candidateId: 'c11',
        importance: 'key',
        kind: 'number',
        source: {
          kind: 'prose',
          blockId: block.id,
          assertionId: assertionId(block.id),
          quantityId: quantity.id,
          metric: '配当予想',
          contextBindingId: `ctx:${block.id}`,
        },
        meaning: {
          subject: '株式会社インソース',
          scope: null,
          basis: null,
          period: '2026年9月期',
          periodKind: 'fullYear',
          metricKind: 'perShare',
          state: 'forecast',
          polarity: 'affirmative',
        },
      };
      const reasons = ['p1b23', 'p1b24'].map((id, i) =>
        proseEvent(id, `c${12 + i}`, '株式会社インソース', '連結', null, 'forecast')
      );
      const full = reviewCandidates(
        JSON.stringify({
          candidateVersion: 3,
          documentType: 'earningsRevision',
          candidates: [...candidates, dividend, ...reasons],
          unverified: [],
        }),
        'earningsRevision',
        pages
      );
      expect(full.unverified).toEqual([]);
      const confirmed = {
        version: 5,
        documentType: 'earningsRevision' as const,
        facts: full.facts,
        unverified: [],
      };
      expect(parseFactSummary(JSON.stringify(confirmed), 'earningsRevision', pages)).toEqual(
        confirmed
      );
      expect(renderFacts(confirmed)).toContain('配当予想の変更なし');
      expect(renderFacts(confirmed)).toContain('普通配当29.5円、記念配当5.5円');
      const breakdown = proseQuantities(block).find((q) => parseQuantity(q.raw)?.value === 29.5)!;
      const wrongDividend = {
        ...dividend,
        source: { ...dividend.source, quantityId: breakdown.id },
      };
      const wrong = reviewCandidates(
        JSON.stringify({
          candidateVersion: 3,
          documentType: 'other',
          candidates: [wrongDividend],
          unverified: [],
        }),
        'other',
        pages
      );
      expect(wrong.facts).toEqual([]);
      expect(wrong.unverified.join(' ')).toContain('対応');
      expect(
        confirmed.facts.find((f) => f.label === '配当予想')!.provenance!.denominator!.value
      ).toBe(1);
      expect(() =>
        verifyCoverage(
          'earningsRevision',
          pages,
          full.facts.filter((f) => f.evidence.kind !== 'prose' || f.evidence.blockId !== 'p1b24')
        )
      ).toThrow('業績予想修正の理由 p1b24');
      expect(() => verifyCoverage('earningsRevision', pages, review.facts)).toThrow('据置配当');
    }
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
