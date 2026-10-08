import { describe, expect, it } from 'vitest';
import expectation from './fixtures/summary-content-expectations.json';
import { textPage, layoutPage, numberCandidate } from './fixtures/v4-test-source';
import { parseFactSummary, renderFacts } from './fact-summary';
import {
  buildPresentation as nativePresentation,
  revalidatePresentation,
  validatePresentation,
} from './summary-presentation';
import {
  buildPresentation,
  completePresentation,
  fixedNarrativeContent,
} from './fixtures/summary-narrative-source';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import { summaryResultId } from './summary-result-id';
import corpus from './fixtures/ir-semantic-corpus.json';
import candidates from './fixtures/ir-semantic-expectations.json';
import { extractPageLayout } from './pdf-layout';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { FactSummary, VerifiedFact } from './fact-contract';
import { candidateResponse } from './fixtures/candidate-test-source';
import { reviewCandidates, CANDIDATE_VERSION } from './fact-candidates';
import { cells, tableAmount } from './fixtures/fact-review-source';
import { buildDocumentContext } from './document-context';
import { validateSavedFacts } from './fact-cache';
import {
  summaryComparison,
  comparisonLabel,
  comparisonIssue,
  comparisonGrowth,
} from './summary-comparison';
import { companyExcerpt } from './summary-company-excerpt';
import { paragraphGroups, sourceInventory } from './summary-source-inventory';
import { isSourceMetadata, dividendPaymentExcerpt } from './summary-content-policy';
import {
  earningsTarget,
  matchesEarningsTarget,
  earningsMetricOrder,
} from './summary-earnings-policy';

const page = textPage(expectation.text);
const facts = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'earnings',
    facts: [numberCandidate(page, '売上高', 1000), { ...numberCandidate(page), id: 'f2' }],
    unverified: [],
  }),
  'earnings',
  [page],
  false
);
const presentation = buildPresentation(facts, [page]);

describe('冒頭と本文の保持・復元・原文参照', () => {
  it('配当支払日の明示欄は隣接セル区切りを含む原文を保持し、空欄・別行は補完しない', () => {
    for (const separator of [' ', '　', '\u00a0', ' │ ', ' ｜ ', ' | ']) {
      const field = `配当金支払開始予定日${separator}２０２６年６月３０日`;
      expect(dividendPaymentExcerpt(field)).toBe(field);
    }
    for (const gap of [' │ │ ', '\n│ ', ' │ 未定 │ '])
      expect(dividendPaymentExcerpt(`配当金支払開始予定日${gap}2026年6月30日`)).toBeNull();
  });
  // Vocabulary belongs here; candidate/coverage and real-PDF stories own the integration boundaries.
  it.each([
    ['2026年3月期 決算短信[IFRS]（連結）', 'fullYear', '連結', 'IFRS', 'IFRS'],
    [
      '2026年3月期 決算短信〔ＩＦＲＳ会計基準〕（連結）',
      'fullYear',
      '連結',
      'IFRS',
      'IFRS会計基準',
    ],
    [
      '2026年3月期 中間決算短信〔日本基準〕（個別）',
      'cumulativeQ2',
      '非連結',
      '日本基準',
      '日本基準',
    ],
    [
      '2026年3月期 第3四半期決算短信〔日本基準〕（単体）',
      'cumulativeQ3',
      '非連結',
      '日本基準',
      '日本基準',
    ],
    [
      '2026年3月期 決算短信［国際会計基準］（非連結）',
      'fullYear',
      '非連結',
      'IFRS',
      '国際会計基準',
    ],
  ] as const)(
    '原文で対応済みの表題属性を冒頭まで保持する: %s',
    (title, periodKind, scope, basis, factBasis) => {
      const resolution = earningsTarget(sourceInventory([textPage(title)], undefined, 'earnings'));
      expect(resolution.issue).toBeNull();
      expect(resolution.target).toMatchObject({ fiscal: '2026年3月期', periodKind, scope, basis });
      const fact = {
        period: '2026年3月期',
        semantics: {
          ...facts.facts[0].semantics,
          periodKind,
          scope: scope === '非連結' ? '単体' : scope,
          basis: factBasis,
        },
      };
      expect(matchesEarningsTarget(fact, resolution.target)).toBe(true);
      for (const semantics of [
        { ...fact.semantics, basis: basis === 'IFRS' ? '日本基準' : 'IFRS' },
        { ...fact.semantics, scope: scope === '連結' ? '非連結' : '連結' },
        {
          ...fact.semantics,
          periodKind: periodKind === 'fullYear' ? ('cumulativeQ2' as const) : ('fullYear' as const),
        },
      ])
        expect(matchesEarningsTarget({ ...fact, semantics }, resolution.target)).toBe(false);
    }
  );

  it('同じ意味の表題・表紙欄は統合し、異なる基準・範囲・期間の衝突は推測しない', () => {
    const cover =
      '2026年3月期 中間決算短信〔IFRS会計基準〕（単体）\n会計基準 国際会計基準 | 範囲 個別';
    const target = (text: string) =>
      earningsTarget(sourceInventory([textPage(text)], undefined, 'earnings'));
    expect(target(cover)).toMatchObject({
      issue: null,
      target: { periodKind: 'cumulativeQ2', scope: '非連結', basis: 'IFRS' },
    });
    expect(target('2026年3月期 決算短信\n（単体）\nIFRS会計基準')).toMatchObject({
      issue: null,
      target: { scope: '非連結', basis: 'IFRS' },
    });
    for (const text of [
      cover.replace('会計基準 国際会計基準', '会計基準 日本基準'),
      cover.replace('範囲 個別', '範囲 連結'),
      cover.replace('中間決算短信', '中間期単独決算短信'),
      cover.replace('中間決算短信', '第3四半期中間決算短信'),
    ])
      expect(target(text)).toEqual({ target: null, issue: 'ambiguous' });
  });

  it('表題の中間・四半期・単独と連結範囲を保持し、同じ決算年だけでは当期としない', () => {
    const source = textPage('2026年３月期 第２四半期（中間期）決算短信〔IFRS〕（連結）');
    const target = earningsTarget(sourceInventory([source], undefined, 'earnings')).target;
    expect(target).toMatchObject({
      fiscal: '2026年3月期',
      periodKind: 'cumulativeQ2',
      scope: '連結',
    });
    const current = facts.facts[0];
    expect(matchesEarningsTarget(current, target)).toBe(false);
    const quarter = {
      ...current,
      period: '2026年3月期中間期',
      semantics: { ...current.semantics, basis: 'IFRS', periodKind: 'cumulativeQ2' as const },
    };
    expect(matchesEarningsTarget(quarter, target)).toBe(true);
    expect(
      matchesEarningsTarget(
        { ...quarter, semantics: { ...quarter.semantics, periodKind: 'standaloneQ2' } },
        target
      )
    ).toBe(false);
    const standalone = textPage('2026年3月期 第2四半期単独 決算短信（個別）');
    expect(
      earningsTarget(sourceInventory([standalone], undefined, 'earnings')).target
    ).toMatchObject({ periodKind: 'standaloneQ2', scope: '非連結' });
    const labels = [
      '基本的1株当たり中間利益',
      '親会社の所有者に帰属する中間利益',
      '税引前利益',
      '営業損失',
      '売上収益',
    ];
    expect([...labels].sort((a, b) => earningsMetricOrder(a) - earningsMetricOrder(b))).toEqual(
      [...labels].reverse()
    );
  });

  it('表題に省略された範囲・会計基準は表紙の明示欄から決め、後の個別・別基準の重要値に置き換えない', () => {
    for (const axis of ['scope', 'basis', 'unknownScope'] as const) {
      const basis = axis === 'basis' ? 'IFRS' : '日本基準';
      const source = textPage(
        [
          axis === 'basis' ? '2026年3月期 決算短信〔IFRS〕（連結）' : '2026年3月期 決算短信',
          `会社名 株式会社テスト | 会計基準 ${basis}${axis === 'unknownScope' ? '' : ' | 範囲 連結'}`,
          '2026年3月期 連結経営成績',
          '売上高は1,000百万円です。',
          '営業利益は100百万円です。',
          axis === 'basis' ? '１．日本基準での業績' : '１．個別経営成績',
          axis === 'basis' ? '会計基準 日本基準' : '範囲 個別',
          '2026年3月期の売上高は900百万円です。',
        ].join('\n')
      );
      const candidate = (blockId: string, local: boolean) => ({
        candidateId: local ? 'c2' : 'c1',
        importance: local ? 'key' : 'detail',
        kind: 'number',
        source: {
          kind: 'prose',
          blockId,
          assertionId: `${blockId}:a1`,
          quantityId: `${blockId}:q1`,
          metric: '売上高',
          contextBindingId: `ctx:${blockId}`,
        },
        meaning: {
          subject: '株式会社テスト',
          scope: local && axis !== 'basis' ? '個別' : '連結',
          basis: local ? '日本基準' : basis,
          period: '2026年3月期',
          periodKind: 'fullYear',
          metricKind: 'amount',
          state: 'actual',
          polarity: 'affirmative',
        },
      });
      const reviewed = reviewCandidates(
        JSON.stringify({
          candidateVersion: CANDIDATE_VERSION,
          documentType: 'earnings',
          candidates: [candidate('p1b4', false), candidate('p1b8', true)],
          unverified: [],
        }),
        'earnings',
        [source]
      );
      expect(reviewed.unverified).toEqual([]);
      expect(reviewed.facts).toHaveLength(2);
      const summary: FactSummary = {
        version: 6,
        documentType: 'earnings',
        facts: reviewed.facts,
        unverified: [],
      };
      const target = earningsTarget(sourceInventory([source], undefined, 'earnings'));
      expect(target.target).toMatchObject({
        basis,
        scope: axis === 'unknownScope' ? null : '連結',
        subject: '株式会社テスト',
      });
      const display = nativePresentation(summary, [source]);
      expect(display.overview).toEqual(
        axis === 'unknownScope' ? [] : [reviewed.facts.find((fact) => fact.value === 1000)!.id]
      );
      const markdown = renderFacts(summary, display);
      const overview = markdown.split('## 業績と増減要因')[0];
      expect(overview).not.toContain('900');
      if (axis === 'unknownScope') expect(overview).toContain('報告対象の範囲が未特定');
      else expect(overview).toContain('1,000百万円');
      expect(markdown).toContain('900百万円');
    }
  });

  const forecastPage = (
    unit: {
      period: string;
      subject: string | null;
      scope: string | null;
      basis: string | null;
      heading?: string;
      fields?: string;
      ownPeriod?: boolean;
    },
    pageNumber: number,
    offset = 0
  ) =>
    cells(
      [
        ...(unit.subject
          ? [[`会社名 ${unit.subject}`, 0, 0, 220] as [string, number, number, number]]
          : []),
        [unit.heading ?? `1. ${unit.period}${unit.scope ?? ''}業績予想の修正`, 0, 30, 460],
        ...(unit.basis
          ? [[`会計基準 ${unit.basis}`, 0, 60, 180] as [string, number, number, number]]
          : []),
        ...(unit.fields ? [[unit.fields, 0, 70, 300] as [string, number, number, number]] : []),
        ['売上高', 400, 90, 80],
        ['営業利益', 600, 90, 80],
        ['百万円', 410, 120, 60],
        ['百万円', 610, 120, 60],
        [(unit.ownPeriod ? unit.period : '') + '前回予想', 0, 150, 320],
        [String(100 + offset), 410, 150, 30],
        ['10', 610, 150, 30],
        [(unit.ownPeriod ? unit.period : '') + '修正後予想', 0, 180, 320],
        [String(200 + offset), 410, 180, 30],
        ['20', 610, 180, 30],
      ],
      pageNumber
    );

  // The headline owns reporting-unit selection; source verification still retains other units.
  it('宣言した予想期・主体・範囲・基準だけを冒頭へ載せ、別単位の修正後予想は本文に残す', () => {
    const target = '2027年3月期';
    const units = [
      { period: target, scope: '連結', basis: '日本基準', subject: '株式会社テスト' },
      { period: target, scope: '個別', basis: '日本基準', subject: '株式会社テスト' },
      { period: target, scope: '連結', basis: 'IFRS', subject: '株式会社テスト' },
      { period: '2028年3月期', scope: '連結', basis: '日本基準', subject: '株式会社テスト' },
      { period: target, scope: '連結', basis: '日本基準', subject: '株式会社子会社' },
      { period: target + '第1四半期', scope: '連結', basis: '日本基準', subject: '株式会社テスト' },
    ];
    const pages = [
      textPage('2026年3月期 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト'),
      ...units.map((unit, i) => forecastPage(unit, i + 2, i * 10)),
    ];
    const inputs = buildDocumentContext(pages)
      .tableMappings.filter((mapping) =>
        mapping.metricIds.some(
          (id) => pages.flatMap((page) => page.spans).find((s) => s.id === id)?.text === '売上高'
        )
      )
      .map((mapping) => {
        const source = pages.find((page) => page.quantities.some((q) => q.id === mapping.valueId))!;
        const unit = units[source.pageNumber - 2];
        const axis = mapping.periodIds
          .map((id) => source.spans.find((s) => s.id === id)!.text)
          .join('');
        const fact = tableAmount(pages, mapping, {
          ...unit,
          state: axis === '前回予想' ? 'forecastBefore' : 'forecastAfter',
        });
        if (source.pageNumber === 7) fact.semantics.periodKind = 'cumulativeQ1';
        return fact;
      });
    const reviewed = reviewCandidates(
      candidateResponse(inputs, pages, 'earnings'),
      'earnings',
      pages
    );
    expect(reviewed.unverified).toEqual([]);
    expect(reviewed.facts).toHaveLength(12);
    const summary: FactSummary = {
      version: 6,
      documentType: 'earnings',
      facts: reviewed.facts,
      unverified: [],
    };
    const selected = reviewed.facts.find(
      (fact) => fact.page === 2 && fact.valueKind === 'forecastAfter'
    )!;
    const display = nativePresentation(summary, pages);
    expect(display.overview).toEqual([selected.id]);
    expect(
      nativePresentation({ ...summary, facts: [...summary.facts].reverse() }, pages).overview
    ).toEqual([selected.id]);
    expect(
      nativePresentation(
        { ...summary, facts: summary.facts.filter((fact) => fact.page !== 2) },
        pages
      ).overview
    ).toEqual([]);
    expect(display.sections.flatMap((section) => section.factIds)).toHaveLength(12);
    const markdown = renderFacts(summary, display);
    const overview = markdown.split('## 通期見通し・前提')[0];
    expect(overview).toContain('100百万円 → 200百万円');
    for (const value of [210, 220, 230, 240, 250]) {
      expect(overview).not.toContain(`${value}百万円`);
      expect(markdown).toContain(`${value}百万円`);
    }
    const savedFacts = JSON.parse(JSON.stringify(summary));
    validateSavedFacts(savedFacts);
    const restored = revalidatePresentation(JSON.parse(JSON.stringify(display)), savedFacts, pages);
    expect(renderFacts(savedFacts, restored)).toBe(markdown);
    const reading = buildSummaryHtml(markdown, null, { companyName: 'テスト', title: '決算' });
    expect(reading.split('通期見通し・前提')[0]).not.toContain('210百万円');
    expect(reading).toContain('210百万円');
    const altered = structuredClone(restored);
    altered.overview.push(
      reviewed.facts.find((fact) => fact.page === 3 && fact.valueKind === 'forecastAfter')!.id
    );
    // Source-free storage integrity is separate from reporting-unit proof.
    expect(() => validatePresentation(altered, savedFacts)).not.toThrow();
    expect(() => revalidatePresentation(altered, savedFacts, pages)).toThrow('報告対象');
  });

  it('当期見出しが競合しても予想のない本文保持を妨げない', () => {
    const source = textPage('2026年3月期 第1四半期第2四半期決算短信〔日本基準〕（連結）');
    const summary: FactSummary = {
      version: 6,
      documentType: 'earnings',
      facts: [],
      unverified: ['原文照合待ち'],
    };
    expect(nativePresentation(summary, [source]).overview).toEqual([]);
  });

  it.each([
    [
      '当期形状が競合・予想独立',
      '2026年3月期 第1四半期第2四半期決算短信〔日本基準〕（連結）',
      { period: '2027年3月期' },
      true,
    ],
    ['同年度の通期', '2026年3月期 中間決算短信〔日本基準〕（連結）', {}, true],
    [
      '宣言した個別IFRS',
      '2026年3月期 決算短信〔日本基準〕（連結）',
      { scope: '個別', basis: 'IFRS', period: '2027年3月期' },
      true,
    ],
    ['範囲不明', '2026年3月期 決算短信〔日本基準〕', { scope: null }, false],
    ['会計基準不明', '2026年3月期 決算短信（連結）', { basis: null }, false],
    ['主体不明', '2026年3月期 決算短信〔日本基準〕（連結）', { subject: null }, false],
    [
      '予想期未宣言',
      '2026年3月期 決算短信〔日本基準〕（連結）',
      { heading: '1. 連結業績予想の修正', ownPeriod: true },
      false,
    ],
  ] as const)(
    '予想の報告単位は数値の存否や当期形状から補わない: %s',
    (_, cover, overrides, admitted) => {
      const unit = {
        period: '2026年3月期',
        subject: '株式会社テスト',
        scope: '連結',
        basis: '日本基準',
        ...overrides,
      };
      const pages = [
        textPage(cover + (unit.subject ? '\n会社名 株式会社テスト' : '')),
        forecastPage(unit, 2),
      ];
      const mapping = buildDocumentContext(pages).tableMappings.find(
        (mapping) => pages[1].quantities.find((q) => q.id === mapping.valueId)?.text === '200'
      )!;
      expect(mapping).toBeDefined();
      const input = tableAmount(pages, mapping, {
        ...unit,
        subject: unit.subject ?? '',
        state: 'forecastAfter',
      });
      input.semantics.subject = unit.subject;
      const reviewed = reviewCandidates(
        candidateResponse([input], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(reviewed.unverified).toEqual([]);
      expect(reviewed.facts).toHaveLength(1);
      const summary: FactSummary = {
        version: 6,
        documentType: 'earnings',
        facts: reviewed.facts,
        unverified: [],
      };
      const display = nativePresentation(summary, pages);
      expect(display.overview).toEqual(admitted ? [reviewed.facts[0].id] : []);
      expect(display.sections.flatMap((section) => section.factIds)).toEqual([
        reviewed.facts[0].id,
      ]);
    }
  );

  it.each(['1. 経営計画', '1. 2026年3月期・2027年3月期 連結業績予想の修正'])(
    '未宣言・競合する予想欄は本文の確定期間から補わない: %s',
    (heading) => {
      const source = textPage(
        '2026年3月期 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n' +
          heading +
          '\n範囲 連結\n会計基準 日本基準\n2026年3月期 修正後予想：売上高は200百万円です。'
      );
      const input = numberCandidate(source, '売上高', 200);
      input.valueKind = input.semantics.state = 'forecastAfter';
      const reviewed = reviewCandidates(
        candidateResponse([input], [source], 'earnings'),
        'earnings',
        [source]
      );
      expect(reviewed.unverified).toEqual([]);
      expect(reviewed.facts).toHaveLength(1);
      const summary: FactSummary = {
        version: 6,
        documentType: 'earnings',
        facts: reviewed.facts,
        unverified: [],
      };
      expect(nativePresentation(summary, [source]).overview).toEqual([]);
    }
  );

  it.each(['範囲 連結 | 範囲 個別', '会計基準 日本基準 | 会計基準 IFRS'])(
    '予想欄の属性が競合しても後の別年度の生存値で置き換えない: %s',
    (fields) => {
      const issuer = { subject: '株式会社テスト', scope: '連結', basis: '日本基準' };
      const pages = [
        textPage('2026年3月期 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト'),
        forecastPage({ ...issuer, period: '2027年3月期', fields }, 2),
        forecastPage({ ...issuer, period: '2028年3月期' }, 3),
      ];
      const mapping = buildDocumentContext(pages).tableMappings.find(
        (mapping) => pages[2].quantities.find((q) => q.id === mapping.valueId)?.text === '200'
      )!;
      const input = tableAmount(pages, mapping, {
        ...issuer,
        period: '2028年3月期',
        state: 'forecastAfter',
      });
      const reviewed = reviewCandidates(
        candidateResponse([input], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(reviewed.unverified).toEqual([]);
      expect(reviewed.facts).toHaveLength(1);
      const summary: FactSummary = {
        version: 6,
        documentType: 'earnings',
        facts: reviewed.facts,
        unverified: [],
      };
      expect(nativePresentation(summary, pages).overview).toEqual([]);
    }
  );

  it('当期の詳細値を前年の重要値より優先し、当期主要値の欠落を別期・別範囲・率・EPS・予想で埋めない', () => {
    const current = { ...facts.facts[0], id: 'current-detail', importance: 'detail' as const };
    const prior = {
      ...current,
      id: 'prior-key',
      period: '2025年3月期',
      importance: 'key' as const,
    };
    const separate = {
      ...current,
      id: 'separate',
      semantics: { ...current.semantics, scope: '非連結' },
    };
    const otherSubject = {
      ...current,
      id: 'other-subject',
      semantics: { ...current.semantics, subject: '株式会社別会社' },
    };
    const rate = {
      ...current,
      id: 'rate',
      semantics: { ...current.semantics, metricKind: 'rate' as const },
    };
    const eps = {
      ...current,
      id: 'eps',
      label: '1株当たり当期純利益',
      semantics: { ...current.semantics, metricKind: 'perShare' as const },
    };
    const forecast = {
      ...current,
      id: 'forecast',
      valueKind: 'forecast' as const,
      semantics: { ...current.semantics, state: 'forecast' as const },
    };
    const others = [prior, separate, otherSubject, rate, eps, forecast, facts.facts[1]];
    for (const ordered of [[...others, current], [current, ...others].reverse()]) {
      const summary = { ...facts, facts: ordered };
      const display = nativePresentation(summary, [page]);
      expect(display.overview).toContain(current.id);
      for (const alternative of others.slice(0, -1))
        expect(display.overview).not.toContain(alternative.id);
    }
    const incomplete = {
      ...facts,
      facts: others,
      unverified: ['COVERAGE:当年決算実績の重要指標 revenue:原文対応を確認できません'],
    };
    const display = nativePresentation(incomplete, [page]);
    expect(display.overview).toEqual([facts.facts[1].id]);
    const markdown = renderFacts(incomplete, display);
    const overview = markdown.split('## 業績と増減要因')[0];
    expect(overview).toContain('主要数値に未確認項目');
    expect(overview).toContain('2026年3月期 実績の未確認');
    expect(overview).toContain('未確認：売上高・売上収益');
    expect(overview).not.toContain('1,000');
    expect(overview.indexOf('主要数値に未確認項目')).toBeLessThan(overview.indexOf('- 営業利益'));
    expect(markdown).toContain('### 2025年3月期 実績');
    expect(markdown).toContain('1,000百万円');
    const reading = buildSummaryHtml(markdown, null, {
      companyName: 'テスト',
      title: '決算',
    }).replace(/<details\b[\s\S]*?<\/details>/g, '');
    expect(reading).toContain('未確認：売上高・売上収益');
    expect(reading.indexOf('主要数値に未確認項目')).toBeLessThan(reading.indexOf('業績と増減要因'));
  });

  it('対象期が未記載・不明・競合する場合は残存値を当期へ昇格せず、全数値を対象期付きで保持する', () => {
    for (const heading of [
      '経営成績',
      '対象期未定 決算短信',
      '2026年3月期・2025年3月期 決算短信',
    ]) {
      const source = textPage(expectation.text.replace('2026年3月期 連結経営成績', heading));
      const display = nativePresentation(facts, [source]);
      expect(display.overview.some((id) => facts.facts.some((fact) => fact.id === id))).toBe(false);
      const markdown = renderFacts(facts, display);
      expect(markdown.split('## 業績と増減要因')[0]).toContain('報告対象期が未特定');
      expect(markdown).toContain('### 2026年3月期 実績');
      expect(markdown).toContain('1,000百万円');
    }
  });

  it('IFRSの税引前利益を独立した名称で並べ、経常利益を欠落扱いしない', () => {
    const source = textPage(expectation.text + '\n本決算短信に記載の予想は不確実性を含みます。');
    const current = facts.facts[1];
    const pretax = { ...current, id: 'pretax', label: '税引前利益' };
    const profit = { ...current, id: 'profit', label: '親会社の所有者に帰属する当期利益' };
    const separateOrdinary = {
      ...current,
      id: 'separate-ordinary',
      label: '経常利益',
      period: '2025年3月期',
      semantics: { ...current.semantics, scope: '非連結' },
    };
    const summary = { ...facts, facts: [profit, pretax, ...facts.facts, separateOrdinary] };
    const display = nativePresentation(summary, [source]);
    expect(display.overview).toEqual([facts.facts[0].id, current.id, pretax.id, profit.id]);
    const markdown = renderFacts(summary, display);
    expect(markdown).not.toContain('主要数値に未確認項目');
    const rows = markdown
      .split('\n')
      .filter((line) => line.startsWith('| ') && line.includes('百万円'));
    expect(rows.slice(0, 4).map((row) => row.split(' | ')[0])).toEqual([
      '| 売上高',
      '| 営業利益',
      '| 税引前利益',
      '| 親会社の所有者に帰属する当期利益',
    ]);
    expect(rows[4]).toContain('経常利益');
    const incomplete = {
      ...facts,
      unverified: [
        'COVERAGE:通期予想の重要指標 revenue: 未確認',
        'COVERAGE:通期予想の1株当たり利益',
        'COVERAGE:配当の重要事実 対象期=2027年3月期 区分=forecast',
      ],
    };
    expect(
      renderFacts(incomplete, nativePresentation(incomplete, [source])).split(
        '## 業績と増減要因'
      )[0]
    ).toContain('未確認の通期予想：売上高・売上収益、1株当たり利益');
    const partial = renderFacts(incomplete, nativePresentation(incomplete, [source])).split(
      '## 業績と増減要因'
    )[0];
    expect(partial).toContain('未確認の配当：2027年3月期 予想');
    expect(partial).not.toContain('経常利益');
  });

  it('中間利益の実績を通期予想と区別し、理由は一つ、引用中の句点とページをまたぐ文は保つ', () => {
    const current = {
      ...facts.facts[1],
      id: 'actual-net',
      label: '親会社の所有者に帰属する中間利益',
    };
    const future = {
      ...current,
      id: 'forecast-net',
      label: '親会社の所有者に帰属する当期利益',
      valueKind: 'forecast' as const,
      semantics: { ...current.semantics, state: 'forecast' as const },
    };
    const document = { ...facts, facts: [...facts.facts, future, current] };
    const reasons = ['新店効果により増収となりました。', '価格転嫁により増益となりました。'];
    const first = textPage(
      expectation.text + '\n1. 経営成績に関する説明\n' + reasons.join('\n') + '\n新事業は「ソリュー'
    );
    const second = textPage('株式会社テスト 2026年3月期 決算短信\nション」の提案を進めました。', 2);
    const display = buildPresentation(document, [first, second]);
    expect(display.overview).toContain(current.id);
    expect(display.overview).not.toContain(future.id);
    expect(display.overview.filter((id) => id.startsWith('source:')).length).toBeLessThanOrEqual(1);
    const note =
      '（注）基準「表示」（以下「本基準」という。）を早期適用しており、会計方針の変更を反映しています。';
    expect(companyExcerpt({ text: note, role: 'performance' })).toBe(note);
    expect(
      paragraphGroups(sourceInventory([first, second], undefined, 'earnings'))
        .map((e) => e.text)
        .join('\n')
    ).toContain('新事業は「ソリュー ション」の提案を進めました。');
    expect(display.excerpts.some((e) => e.text === reasons[1])).toBe(true);
    const selected = display.overview.find((id) => id.startsWith('source:'))!;
    expect(selected).toBeDefined();
    const content = fixedNarrativeContent(document, display);
    content.sections[0].summary = [
      { id: 'reason', text: '新店効果が売上を押し上げた。', sourceIds: [selected] },
    ];
    const supported = completePresentation(display, document, content);
    supported.organization.status = 'partial';
    const overview = renderFacts(document, supported).split('## 業績と増減要因')[0];
    expect(overview).toContain('新店効果が売上を押し上げた。');
    expect(overview).toContain('[p.1](tdnet-page:1)');
    expect(overview).not.toContain(reasons[0]);
    const pending = nativePresentation(document, [first, second]);
    const pendingSummary = renderFacts(document, pending);
    const pendingOverview = pendingSummary.split('## 業績と増減要因')[0];
    expect(pendingSummary).toContain('補足要約の未整理部分');
    expect(pendingOverview).not.toContain(reasons[0]);
    expect(
      renderFacts(document, revalidatePresentation(supported, document, [first, second]))
    ).toBe(renderFacts(document, supported));
    const incomplete = structuredClone(supported);
    incomplete.organization.review!.sources[selected] = '説明の一部が未要約';
    const incompleteSummary = renderFacts(document, incomplete);
    const incompleteOverview = incompleteSummary.split('## 業績と増減要因')[0];
    expect(incompleteOverview).toContain('新店効果が売上を押し上げた。');
    expect(incompleteSummary).toContain('補足要約の未整理部分');
  });

  it('目次・定型注意書き・記載省略・該当なしを冒頭の理由や条件にせず全文は保持する', () => {
    const notice =
      '※ 添付される四半期連結財務諸表に対する公認会計士又は監査法人によるレビュー：無\n※ 業績予想の適切な利用に関する説明、その他特記事項\n本資料に記載されている業績予想につきましては発表日現在のデータに基づき作成したものであり、予想につきましては様々な不確定要素が内在しておりますので、実際の業績はこれらの予想数値と異なる可能性があります。なお、上記予想に関する事項は、（添付資料）２ページ「（３）連結業績予想などの将来予測情報に関する説明」をご参照ください。';
    const toc =
      '１．経営成績等の概況……………………２\n（１）当中間期の経営成績の概況……………………２\n２．財務諸表……………………４';
    const routine =
      '（セグメント情報等の注記）【セグメント情報】前中間連結会計期間(自2025年３月１日至2025年８月31日)\n当社グループの報告セグメントはレストラン事業のみであり、他の事業セグメントの重要性が乏しいため、記載を省略しております。';
    const absence = '（株主資本の金額に著しい変動があった場合の注記）該当事項はありません。';
    const risk = '新規事業は承認を条件に実施する予定です。';
    expect(isSourceMetadata(notice)).toBe(true);
    expect(isSourceMetadata(notice + risk)).toBe(false);
    const wrappedNotice =
      '※ 業績予想の適切な利用に関する説明、その他特記事項（将来に関する記述等についてのご注意）本資料に記載されている業績見通し等の将来に関する記述は、その達成を約束するものではありません。また、実際の業績は様々な要因により大きく異なる可能性があります。業績予想の前提となる条件及び業績予想のご利用にあたっての注意事項等については、添付資料Ｐ.６「１.連結業績予想などの将来予測情報に関する説明」をご覧ください。';
    expect(isSourceMetadata(wrappedNotice)).toBe(true);
    expect(isSourceMetadata(wrappedNotice + risk)).toBe(false);
    expect(
      companyExcerpt({ text: '純損益に振替えられる可能性のある項目', role: 'performance' })
    ).toBeNull();
    const source = textPage(
      expectation.text +
        '\n' +
        notice +
        '\n○添付資料の目次\n' +
        toc +
        '\n４．セグメント情報等の注記\n' +
        routine +
        '\n' +
        absence +
        '\n５．取引条件\n' +
        risk
    );
    const display = buildPresentation(facts, [source]);
    const html = buildSummaryHtml(renderFacts(facts, display), null, {
      companyName: 'テスト',
      title: '決算',
      pdfUrl: 'https://www.release.tdnet.info/inbs/test.pdf',
    });
    const reading = html.replace(/<details\b[\s\S]*?<\/details>/g, '');
    for (const text of [notice, routine, absence].flatMap((text) => text.split('\n')))
      expect(reading).not.toContain(text);
    expect(reading).not.toContain('……………………');
    expect(html).toContain(risk);
    for (const text of [notice, routine, absence].flatMap((text) => text.split('\n')))
      expect(html).toContain(text);
    expect(
      display.excerpts
        .filter((e) => e.text.includes('……………………') || e.text === notice)
        .every((e) => e.role === 'document')
    ).toBe(true);
  });
  it('比較条件が一致する確定値から増減・赤字変化を示し、異なる条件や範囲値は比較しない', () => {
    const current = facts.facts.find((f) => f.label === '営業利益')!;
    const previous = {
      ...current,
      id: 'previous',
      period: '2025年3月期',
      value: 120,
      quantity: { ...current.quantity!, decimal: '120' },
    } as VerifiedFact;
    const comparison = summaryComparison(current, [current, previous])!;
    expect(comparisonIssue(current, [current])).toBe('前年の値が要約に未抽出');
    const printed = { ...current, period: '２０２６年３月期' };
    expect(summaryComparison(printed, [printed, previous])?.reference.id).toBe(previous.id);
    expect(comparisonIssue(printed, [printed])).toBe('前年の値が要約に未抽出');
    const aliasedCurrent = {
      ...current,
      semantics: { ...current.semantics, scope: '個別', basis: 'IFRS会計基準' },
    };
    for (const [scope, basis, comparable] of [
      ['非連結', '国際会計基準', true],
      ['単体', 'IFRS', true],
      ['連結', 'IFRS', false],
      ['個別', '日本基準', false],
    ] as const) {
      const other = { ...previous, semantics: { ...previous.semantics, scope, basis } };
      expect(summaryComparison(aliasedCurrent, [aliasedCurrent, other]) !== null).toBe(comparable);
    }

    expect(
      comparisonIssue(current, [
        current,
        { ...previous, semantics: { ...previous.semantics, scope: '非連結' } },
      ])
    ).toBe('比較条件・根拠の対応が未確認');
    expect(comparisonLabel(current, comparison)).toBe('↓減益');
    expect(comparisonGrowth(current, comparison)).toEqual({ kind: 'change', rate: '−16.7%' });
    const loss = {
      ...current,
      quantity: { ...current.quantity!, decimal: '-100' },
    } as VerifiedFact;
    const oldLoss = {
      ...previous,
      quantity: { ...previous.quantity!, decimal: '-120' },
    } as VerifiedFact;
    expect(comparisonLabel(loss, summaryComparison(loss, [loss, oldLoss])!)).toBe('↑赤字縮小');
    expect(comparisonGrowth(loss, summaryComparison(loss, [loss, oldLoss])!)).toEqual({
      kind: 'loss',
      rate: '16.7%',
    });
    const lossAmount = { ...current, label: '営業損失' };
    const previousLossAmount = { ...previous, label: '営業損失' };
    expect(
      comparisonLabel(lossAmount, summaryComparison(lossAmount, [lossAmount, previousLossAmount])!)
    ).toBe('↑損失縮小');
    expect(
      comparisonGrowth(lossAmount, summaryComparison(lossAmount, [lossAmount, previousLossAmount])!)
    ).toEqual({ kind: 'loss', rate: '16.7%' });
    expect(
      summaryComparison(current, [
        current,
        { ...previous, semantics: { ...previous.semantics, scope: '非連結' } },
      ])
    ).toBeNull();
    expect(
      summaryComparison(
        {
          ...current,
          kind: 'range',
          quantity: { raw: '100～150', decimal: null, lower: '100', upper: '150', sourceIds: [] },
        },
        [previous]
      )
    ).toBeNull();
  });
  it('3期の比較で中間期の所有行を残し、全確定値を順序によらず表示・保存復元する', () => {
    const source = cells(
      [
        ['2026年3月期 決算短信（連結）', 0, -30, 480],
        ['上場会社名 株式会社テスト', 0, 0, 240],
        ['1. 連結経営成績', 0, 30, 280],
        ['売上高', 280, 60, 140],
        ['営業利益', 480, 60, 140],
        ['当期純利益', 680, 60, 140],
        ['百万円', 340, 90, 80],
        ['百万円', 540, 90, 80],
        ['百万円', 740, 90, 80],
        ['2026年3月期', 0, 120, 140],
        ['100', 340, 120, 80],
        ['20', 540, 120, 80],
        ['10', 740, 120, 80],
        ['2025年3月期', 0, 150, 140],
        ['90', 340, 150, 80],
        ['15', 540, 150, 80],
        ['8', 740, 150, 80],
        ['2024年3月期', 0, 180, 140],
        ['80', 340, 180, 80],
        ['10', 540, 180, 80],
        ['5', 740, 180, 80],
      ],
      1
    );
    const inputs = buildDocumentContext([source]).tableMappings.map((mapping) =>
      tableAmount([source], mapping, {
        period: source.spans.find((span) => span.id === mapping.periodIds[0])!.text,
        subject: '株式会社テスト',
        scope: '連結',
        basis: null,
        state: 'actual',
      })
    );
    const reviewed = reviewCandidates(candidateResponse(inputs, [source], 'earnings'), 'earnings', [
      source,
    ]);
    expect(reviewed.unverified).toEqual([]);
    expect(reviewed.facts).toHaveLength(9);
    let firstMarkdown: string | undefined;
    for (const ordered of [reviewed.facts, [...reviewed.facts].reverse()]) {
      const summary: FactSummary = {
        version: 6,
        documentType: 'earnings',
        facts: ordered,
        unverified: [],
      };
      const display = nativePresentation(summary, [source]);
      const markdown = renderFacts(summary, display);
      const rows = markdown
        .split('\n')
        .filter((line) => line.startsWith('| ') && line.includes('百万円'));
      if (firstMarkdown) expect(markdown).toBe(firstMarkdown);
      firstMarkdown = markdown;
      expect(markdown).toContain('### 2026年3月期 実績');
      expect(markdown).toContain('### 2025年3月期 実績');
      expect(rows.map((row) => row.split(' | ')[0])).toEqual([
        '| 売上高',
        '| 営業利益',
        '| 当期純利益',
        '| 売上高',
        '| 営業利益',
        '| 当期純利益',
      ]);
      // A comparison-owning row must survive even when another row references it.
      expect(rows).toHaveLength(6);
      expect(
        rows.some((row) => row.includes('90百万円') && row.includes('2024年3月期 80百万円'))
      ).toBe(true);
      expect(
        rows.some((row) => row.includes('15百万円') && row.includes('2024年3月期 10百万円'))
      ).toBe(true);
      expect(
        rows.some((row) => row.includes('8百万円') && row.includes('2024年3月期 5百万円'))
      ).toBe(true);
      const reading = buildSummaryHtml(markdown, null, {
        companyName: 'テスト',
        title: '決算',
      }).replace(/<details\b[\s\S]*?<\/details>/g, '');
      expect(reading).toContain('2024年3月期');
      expect(reading).toContain('80百万円');
      const savedFacts: unknown = JSON.parse(JSON.stringify(summary));
      validateSavedFacts(savedFacts);
      const restored = revalidatePresentation(JSON.parse(JSON.stringify(display)), savedFacts, [
        source,
      ]);
      expect(renderFacts(savedFacts, restored)).toBe(markdown);
    }
  });

  it('成長率は十進値で概算し、符号転換・ゼロ基準・赤字額の率を区別する', () => {
    const original = facts.facts.find((f) => f.label === '営業利益')!;
    const pair = (now: string, before: string) => {
      const current = { ...original, quantity: { ...original.quantity!, decimal: now, raw: now } };
      const reference = {
        ...original,
        id: 'previous',
        period: '2025年3月期',
        quantity: { ...original.quantity!, decimal: before, raw: before },
      };
      return { current, reference, comparison: summaryComparison(current, [current, reference])! };
    };
    for (const [now, before, label, growth] of [
      ['11457', '6628', '↑増益', { kind: 'change', rate: '+72.9%' }],
      ['-150', '-100', '↓赤字拡大', { kind: 'loss', rate: '50.0%' }],
      ['20', '-10', '↑黒字転換', null],
      ['-10', '20', '↓赤字転落', null],
      ['0', '-100', '↑赤字解消', { kind: 'loss', rate: '100.0%' }],
      ['-10', '0', '↓赤字転落', { kind: 'zeroBase' }],
      ['10', '0', '↑増益', { kind: 'zeroBase' }],
      ['0', '0', '→横ばい', { kind: 'zeroBase' }],
      ['0', '100', '↓減益', { kind: 'change', rate: '−100.0%' }],
      ['100', '100', '→横ばい', { kind: 'change', rate: '0.0%' }],
      ['1.0001', '1', '↑増益', { kind: 'change', rate: '+0.1%未満' }],
      ['0.9999', '1', '↓減益', { kind: 'change', rate: '−0.1%未満' }],
      ['1.0005', '1', '↑増益', { kind: 'change', rate: '+0.1%' }],
      ['0.9995', '1', '↓減益', { kind: 'change', rate: '−0.1%' }],
      [
        '20000000000000000000.1',
        '10000000000000000000.05',
        '↑増益',
        { kind: 'change', rate: '+100.0%' },
      ],
    ] as const) {
      const { current, comparison } = pair(now, before);
      expect(comparisonLabel(current, comparison)).toBe(label);
      expect(comparisonGrowth(current, comparison)).toEqual(growth);
    }
    const { current, reference } = pair('-100', '-120');
    const summary = { ...facts, facts: [current, reference] };
    const display = buildPresentation(summary, [page]);
    const overview = renderFacts(summary, display).split('## 業績と増減要因')[0]!;
    const html = buildSummaryHtml(overview, null, {
      companyName: 'テスト',
      title: '決算',
      pdfUrl: 'https://www.release.tdnet.info/inbs/test.pdf',
    });
    expect(html).toContain('↑赤字縮小 約16.7%');
    expect(html).toContain('-100百万円');
    expect(html).toContain('前期 -120百万円');
    expect(renderFacts(summary, display)).toContain('表示金額から計算');
    expect(summary.facts).toEqual([current, reference]);
    expect(
      comparisonGrowth(current, { ...pair('-100', '-120').comparison, axis: 'revision' })
    ).toBeNull();
  });
  it('修正前後の数値と上方・下方・据え置きを冒頭に表示する', () => {
    const id = 'revision-20260910';
    const pages = corpus
      .find((c) => c.id === id)!
      .pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
    const native = reviewCandidates(
      candidateResponse(
        candidates.find((c) => c.id === id)!.facts as unknown as VerifiedFact[],
        pages,
        'earningsRevision'
      ),
      'earningsRevision',
      pages
    ).facts;
    const summary = { ...facts, documentType: 'earningsRevision' as const, facts: native };
    const overview = renderFacts(summary, buildPresentation(summary, pages)).split(
      '## 修正内容'
    )[0]!;
    expect(overview).toContain('**↑上方修正** 2,800百万円 → 2,900百万円');
    expect(overview).toContain('親会社の所有者に帰属する当期利益');
    const after = native.find(
      (f) => f.label === '営業利益' && f.semantics.state === 'forecastAfter'
    )!;
    const same = { ...after, quantity: { ...after.quantity!, decimal: '2800' } } as VerifiedFact;
    const lower = { ...after, quantity: { ...after.quantity!, decimal: '2700' } } as VerifiedFact;
    expect(
      comparisonLabel(
        same,
        summaryComparison(same, [...native.filter((f) => f.id !== after.id), same])!
      )
    ).toBe('→据え置き');
    expect(
      comparisonLabel(
        lower,
        summaryComparison(lower, [...native.filter((f) => f.id !== after.id), lower])!
      )
    ).toBe('↓下方修正');
  });
  it('生成要約の言い換えと重要条件を通常表示し、全文原文を閉じたトグルに保持する', () => {
    const draft = buildPresentation(facts, [page]);
    const sourceIds = draft.excerpts.map((e) => e.id);
    const content = fixedNarrativeContent(facts, draft);
    content.sections[0].summary = [
      { id: 'reason', text: '増収要因：新商品の販売と価格改定が寄与。', sourceIds },
      {
        id: 'condition',
        text: '共同開発は承認後に実施する予定。開始時期と翌年度への影響は未定。',
        sourceIds,
      },
    ];
    const display = completePresentation(draft, facts, content);
    const html = buildSummaryHtml(renderFacts(facts, display), null, {
      companyName: 'テスト',
      title: '決算',
    });
    const reading = html.replace(/<details\b[\s\S]*?<\/details>/g, '');
    expect(reading).toContain('新商品の販売と価格改定が寄与');
    expect(reading).toContain('共同開発は承認後に実施する予定');
    expect(reading).toContain('開始時期と翌年度への影響は未定');
    expect(reading).not.toContain('原文抜粋');
    expect(reading).not.toContain('価格改定も行いました。');
    expect(reading).not.toContain('補足要約の未整理部分');
    expect(html).toContain('価格改定も行いました。');
    expect(revalidatePresentation(display, facts, [page])).toEqual(display);
  });
  it('説明の内訳・混在した状態・未分類の施策を原文のまま保持する', () => {
    expect(sourceInventory([page]).map((e) => e.text)).toEqual(expectation.retained);
    expect(revalidatePresentation(presentation, facts, [page])).toEqual(presentation);
    const body = renderFacts(facts, presentation).split('\n## 業績と増減要因\n')[1];
    expect(body).toContain('価格改定も行いました。');
    expect(body).toContain('承認を条件に実施する予定です。');
    expect(body).toContain('詳細は未定です。');
    // Literal source quotations do not become verified semantic facts used for scoring.
    expect(facts.facts).toHaveLength(2);
  });
  it('未整理の説明と表を章・ページ別に一度だけ知らせ、全原文を末尾の一つのトグルへ残す', () => {
    const table = cells(
      [
        ['４．キャッシュ・フロー', 0, 10, 180],
        ['営業活動', 0, 40, 70],
        ['50百万円', 150, 40, 60],
        ['40百万円', 250, 40, 60],
      ],
      2
    );
    const display = nativePresentation(facts, [page, table]);
    const summary = renderFacts(facts, display);
    const coverage = summary.split('## 補足要約の未整理部分\n')[1].split('\n## 原文\n')[0];
    expect(coverage.match(/^- 業績と増減要因：/gm)).toHaveLength(1);
    expect(coverage).toContain('説明 [p.1](tdnet-page:1)');
    expect(coverage).toContain('財政状態・資金の動き：数値・表 [p.2](tdnet-page:2)');
    expect(summary.match(/^## 補足要約の未整理部分$/gm)).toHaveLength(1);
    expect(summary).not.toContain('要約未作成');
    expect(summary).not.toContain('\n## 財政状態・資金の動き\n');
    const html = buildSummaryHtml(summary, null, {
      companyName: 'テスト',
      title: '決算',
      pdfUrl: 'https://www.release.tdnet.info/inbs/test.pdf',
    });
    const toggles = html.match(/<details class="tdnet-digest-source"[^>]*>[\s\S]*?<\/details>/g)!;
    expect(toggles).toHaveLength(1);
    expect(toggles[0]).not.toMatch(/^<details[^>]*\bopen\b/);
    expect(toggles[0]).toContain('価格改定も行いました。');
    expect(toggles[0]).toContain('50百万円');
    expect(toggles[0]).toContain('test.pdf#page=2');
    expect(toggles[0]).not.toContain('<table');
    const reading = html.replace(toggles[0], '');
    expect(reading).toContain('<table');
    expect(reading).toContain('1,000百万円');
    expect(reading).toContain('補足要約の未整理部分');
    expect(reading).not.toContain('価格改定も行いました。');
    expect(reading).not.toContain('50百万円');
    expect(renderFacts(facts, revalidatePresentation(display, facts, [page, table]))).toBe(summary);
  });
  it('冒頭の選択を減らしても本文の全事実と引用は変わらない', () => {
    const brief = { ...presentation, overview: [facts.facts[0].id] };
    const body = (text: string) => text.slice(text.indexOf('## 業績と増減要因'));
    expect(body(renderFacts(facts, brief))).toBe(body(renderFacts(facts, presentation)));
    expect(brief.sections.flatMap((s) => s.factIds)).toEqual(facts.facts.map((f) => f.id));
  });
  it('補足の分断された文をつなぎ、段落とページ境界を保って引用枠を出さない', () => {
    const first = textPage(
      expectation.text + '\n共同開発は承認を条件に\n実施する予定です。\n開始時期は未定です。'
    );
    const second = textPage('３．その他の施策\n翌年度への影響は\n現時点では未定です。', 2);
    const display = buildPresentation(facts, [first, second]);
    const summary = renderFacts(facts, display);
    const supplement = summary;
    expect(supplement).toContain('共同開発は承認を条件に 実施する予定です。');
    expect(supplement).toContain('実施する予定です。\n\n開始時期は未定です。');
    expect(supplement).toContain('翌年度への影響は 現時点では未定です。');
    const html = buildSummaryHtml(summary, null, {
      companyName: 'テスト',
      title: '開示',
      pdfUrl: 'https://www.release.tdnet.info/inbs/test.pdf',
    });
    expect(html).not.toContain('<blockquote');
    expect(html).toContain('test.pdf#page=2');
    const sourceToggles = html.match(
      /<details class="tdnet-digest-source"[^>]*>[\s\S]*?<\/details>/g
    )!;
    expect(sourceToggles.length).toBeGreaterThan(0);
    expect(sourceToggles.every((toggle) => !/^<details[^>]*\bopen\b/.test(toggle))).toBe(true);
    expect(
      sourceToggles.every((toggle) => !toggle.includes('<h2') && !toggle.includes('<table'))
    ).toBe(true);
    const lastToggle = sourceToggles.find((toggle) => toggle.includes('共同開発'))!;
    expect(lastToggle).toContain('共同開発は承認を条件に 実施する予定です。');
    expect(lastToggle).toContain('翌年度への影響は 現時点では未定です。');
    expect(lastToggle).toContain('原文を見る（p.1、p.2）');
    expect(html.slice(0, html.indexOf('class="tdnet-digest-source"'))).toContain('開示の要点');
    expect(display.excerpts.map((e) => e.text)).toEqual([
      ...expectation.retained,
      '共同開発は承認を条件に',
      '実施する予定です。',
      '開始時期は未定です。',
      '３．その他の施策',
      '翌年度への影響は',
      '現時点では未定です。',
    ]);
  });
  it('本文欠落・引用変更・未知項目・PDFとの相違を拒否する', () => {
    const missing = structuredClone(presentation);
    missing.sections[0].factIds.pop();
    expect(() => validatePresentation(missing, facts)).toThrow('欠落');
    const changed = structuredClone(presentation);
    changed.excerpts[0].text = '変更された引用';
    expect(() => validatePresentation(changed, facts)).toThrow('欠落・変更');
    expect(() => validatePresentation({ ...presentation, unknown: true }, facts)).toThrow('不正');
    expect(() => validatePresentation({ ...presentation, version: 1 }, facts)).toThrow('不正');
    expect(() =>
      validatePresentation(
        {
          ...presentation,
          overview: [presentation.excerpts.find((e) => e.kind === 'heading')!.id],
        },
        facts
      )
    ).toThrow('冒頭');
    expect(() =>
      revalidatePresentation(presentation, facts, [
        textPage(expectation.text.replace('価格改定', '価格据置')),
      ])
    ).toThrow('PDF');
    const wrapped = layoutPage(
      [
        ['今回予想', 0, 10],
        ['100～', 100, 10],
        ['200～', 200, 10],
        ['通期', 0, 22],
        ['150', 100, 22],
        ['250', 200, 22],
      ].map(([text, x, y], i) => ({
        id: `s${i}`,
        text: String(text),
        x: Number(x),
        y: Number(y),
        width: String(text).length * 5,
        height: 10,
      }))
    );
    const bounds = wrapped.spans.filter((s) => /^100|^150/.test(s.text));
    wrapped.quantities = [
      {
        id: bounds[0].id,
        spanIds: bounds.map((s) => s.id),
        text: '100～\n150',
        x: 100,
        y: 10,
        width: 20,
        height: 10,
      },
    ];
    const pending = { ...facts, facts: [], unverified: ['未確認'] };
    const native = nativePresentation(pending, [wrapped]);
    const range = native.values.find((v) => v.id === bounds[0].id)!;
    expect(range.sourceIds).toHaveLength(2);
    expect(range.decimal).toBeNull();
    expect(revalidatePresentation(native, pending, [wrapped])).toEqual(native);
    const forged = structuredClone(native);
    forged.values.find((v) => v.id === range.id)!.raw = '100～151';
    expect(() => validatePresentation(forged, pending)).toThrow('原文');
    const missingBound = structuredClone(native);
    missingBound.values.find((v) => v.id === range.id)!.sourceIds.pop();
    expect(() => validatePresentation(missingBound, pending)).toThrow('原文');
    // A different value printed in the same row is not this native range's upper bound.
    const wrongColumn = structuredClone(native);
    wrongColumn.values.find((v) => v.id === range.id)!.raw = '100～250';
    expect(() => revalidatePresentation(wrongColumn, pending, [wrapped])).toThrow('欠落・変更');
  });
  it('予定日と本文を含む会社名の段落を管理情報として捨てない', () => {
    const source = textPage(
      '会社名 株式会社テスト\n１．実施時期\n2026年10月15日\n会社名は変更します。承認が条件です。\n会社名変更の理由\n会社名 株式会社対象 | 条件 承認後'
    );
    expect(sourceInventory([source]).map((e) => e.text)).toEqual([
      '１．実施時期',
      '2026年10月15日',
      '会社名は変更します。承認が条件です。',
      '会社名変更の理由',
      '会社名 株式会社対象 | 条件 承認後',
    ]);
  });
  it('MarkdownやHTMLを原文として表示し、安全な物理ページリンクを作る', () => {
    const source = textPage(
      expectation.text +
        '\n説明は[参照](javascript:alert(1)) | <img src=x onerror=alert(1)>です。https://x.com/uluru_ir - 注記。'
    );
    const html = buildSummaryHtml(renderFacts(facts, buildPresentation(facts, [source])), null, {
      companyName: 'テスト',
      title: '開示',
      pdfUrl: 'https://www.release.tdnet.info/inbs/140120260930543649.pdf',
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;img');
    expect(html).toContain('https://x.com/uluru_ir - 注記。');
    expect(html).toContain('140120260930543649.pdf#page=1');
    expect(html).not.toContain('tdnet-page:');
  });
  it('本文・引用を変更すると保存結果IDも変わる', async () => {
    const base = await summaryResultId(
      '140120260930543649.pdf',
      'v79:fixture:fixture:full',
      facts,
      'a'.repeat(64),
      presentation
    );
    const different = buildPresentation(facts, [
      textPage(expectation.text + '\n補足の条件があります。'),
    ]);
    expect(
      await summaryResultId(
        '140120260930543649.pdf',
        'v79:fixture:fixture:full',
        facts,
        'a'.repeat(64),
        different
      )
    ).not.toBe(base);
  });
});
