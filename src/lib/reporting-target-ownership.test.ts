import { expect, it } from 'vitest';
import type { ExtractedPage } from '@/types/summaryMetadata';
import {
  buildDocumentContext,
  documentSubject,
  isReportingCoverField,
  isReportingMetadata,
  reportingCoverBlocks,
} from './document-context';
import { coverageReport, declaredForecastFactIds } from './fact-coverage';
import { reviewCandidates } from './fact-candidates';
import { candidateResponse } from './fixtures/candidate-test-source';
import { cells, tableAmount } from './fixtures/fact-review-source';
import { numberCandidate, textPage } from './fixtures/v4-test-source';
import { buildPresentation } from './summary-presentation';
import { earningsTarget } from './summary-earnings-policy';
import { sourceInventory } from './summary-source-inventory';
import { reportingFieldProjection, reportingFieldSegments } from './reporting-attributes';

const cover = '2026年3月期 決算短信（連結）';
const issuer = '株式会社テスト';

it('別の開示の参照短信で発行会社と予想・月次の根拠を消さない', () => {
  const reference = '2026年3月期 決算短信〔IFRS〕（個別）';
  const first = textPage(
    `2026年5月10日\n各位\n業績予想の修正に関するお知らせ\n会社名 ${issuer}\n範囲 連結\n会計基準 日本基準\n参考資料\n${reference}`
  );
  const { pages, facts } = forecast(first, [`会社名 ${issuer}`, '会計基準 日本基準']);
  const context = buildDocumentContext(pages);
  expect(documentSubject(context)).toBe(issuer);
  const referenceId = first.blocks.find((block) => block.text === reference)!.id;
  expect(
    context.bindings
      .flatMap((binding) =>
        binding.declarations.filter((declaration) => declaration.origin === 'document')
      )
      .some((declaration) => declaration.id === referenceId)
  ).toBe(false);
  const forecastSlots = coverageReport('earningsRevision', pages, facts);
  expect(forecastSlots.map((slot) => slot.requirement)).toEqual([
    'COVERAGE:予想修正の前後 forecastBefore/revenue 対象期=2027年3月期',
    'COVERAGE:予想修正の前後 forecastBefore/operatingProfit 対象期=2027年3月期',
    'COVERAGE:予想修正の前後 forecastAfter/revenue 対象期=2027年3月期',
    'COVERAGE:予想修正の前後 forecastAfter/operatingProfit 対象期=2027年3月期',
  ]);
  expect(forecastSlots.filter((slot) => slot.sourceIds.length > 0)).toHaveLength(4);
  expect([...declaredForecastFactIds(pages, facts)]).toEqual([facts[0].id]);

  const monthly = textPage(
    `月次実績のお知らせ\n会社名 ${issuer}\n1. 2026年6月月次実績\n2026年6月のMRRは100千円です。\n参考資料\n${reference}`
  );
  const monthlySlots = coverageReport('businessUpdate', [monthly], []);
  expect(documentSubject(buildDocumentContext([monthly]))).toBe(issuer);
  expect(monthlySlots.map((slot) => slot.requirement)).toEqual(['COVERAGE:報告対象月']);
  expect(monthlySlots[0].sourceIds).toEqual([
    monthly.blocks.find((block) => block.text.includes('MRR'))!.id,
  ]);
});

it('同じ物理段落の後続参照から発行会社・範囲・基準を借りない', () => {
  const first = cells(
    [
      ['業績予想の修正に関するお知らせ', 0, 0, 480],
      [`会社名 ${issuer}`, 0, 15, 210],
      ['2026年3月期 決算短信〔IFRS〕（個別）', 0, 30, 400],
      ['会社名 株式会社参考', 0, 45, 210],
    ],
    1
  );
  expect(first.blocks).toHaveLength(1);
  const { pages, facts } = forecast(first, [`会社名 ${issuer}`, '会計基準 日本基準']);
  const context = buildDocumentContext(pages);
  expect(documentSubject(context)).toBe(issuer);
  expect(
    context.bindings[0].declarations
      .filter((declaration) => declaration.origin === 'document')
      .map(({ role, value }) => ({ role, value }))
  ).toEqual([{ role: 'subject', value: issuer }]);
  expect([...declaredForecastFactIds(pages, facts)]).toEqual([facts[0].id]);
});

it('先頭のロゴを後続の短信参照で厳格な空の表紙に置き換えない', () => {
  const page = textPage(
    `TEST GROUP\n2026年3月期 決算短信〔日本基準〕（連結）\n会社名 ${issuer}\n1. 2026年3月期連結経営成績\n売上高は100百万円です。`
  );
  expect(reportingCoverBlocks(page.blocks)).toEqual([]);
  expect(documentSubject(buildDocumentContext([page]))).toBe(issuer);
  for (const source of [
    '2026年3月期 決算短信〔日本基準〕（連結）\n売上高は100百万円です。',
    '2026年3月期 決算短信〔日本基準〕（連結） 売上高100百万円',
    '2026年3月期 決算短信〔日本基準〕（連結）\n参考情報',
  ]) {
    const interrupted = textPage(`TEST GROUP\n${source}\n会社名 ${issuer}`);
    expect(documentSubject(buildDocumentContext([interrupted]))).toBeNull();
  }
  const { pages, facts } = forecast(
    textPage(`TEST GROUP\n${cover}\n売上高は100百万円です。\n会社名 ${issuer}`),
    [`会社名 ${issuer}`, '会計基準 日本基準']
  );
  expect([...declaredForecastFactIds(pages, facts)]).toEqual([]);
});

it('予想表題の年と月期が別spanでも同じ3指標の義務と2数量の根拠を保持する', () => {
  const first = textPage(`会社名 ${issuer}\n範囲 連結\n会計基準 日本基準`);
  const forms: [string, number, number, number][][] = [
    [['1. 2027年3月期連結業績予想', 0, 0, 350]],
    [
      ['1. 2027', 0, 0, 65],
      ['年3月期連結業績予想', 65, 0, 240],
    ],
  ];
  for (const heading of forms) {
    const page = cells(
      [
        ...heading,
        ['売上高', 400, 80, 80],
        ['営業利益', 600, 80, 80],
        ['百万円', 410, 110, 60],
        ['百万円', 610, 110, 60],
        ['通期', 0, 140, 300],
        ['200', 410, 140, 30],
        ['20', 610, 140, 30],
      ],
      2
    );
    const slots = coverageReport('earningsRevision', [first, page], []);
    expect(slots.map((slot) => slot.requirement)).toEqual([
      'COVERAGE:業績予想公表の重要指標 revenue 対象期=2027年3月期 区分=forecast',
      'COVERAGE:業績予想公表の重要指標 operatingProfit 対象期=2027年3月期 区分=forecast',
      'COVERAGE:業績予想公表の重要指標 netProfit 対象期=2027年3月期 区分=forecast',
    ]);
    expect(slots.map((slot) => slot.sourceIds.length)).toEqual([1, 1, 0]);
  }
});

it('連絡欄に混在した実績を原文一覧から消して表紙の所有境界を飛び越さない', () => {
  const title = '2026年3月期 決算短信〔日本基準〕（連結）';
  for (const value of [
    '売上高100百万円',
    '発行済株式数100株',
    '売上高100百万ドル',
    '売上高（百万ドル）100',
  ]) {
    const mixed = `TEL 03-0000-0000 ${value}`;
    const first = textPage(`${title}\n${mixed}\n会社名 ${issuer}`);
    const local = textPage(
      `会社名 ${issuer}\n1. 2026年3月期連結経営成績\n会計基準 日本基準\n2026年3月期の売上高は900百万円です。`,
      2
    );
    const pages = [first, local];
    const context = buildDocumentContext(pages);
    expect(documentSubject(context)).toBeNull();
    expect(reportingCoverBlocks(first.blocks).map((block) => block.text)).toEqual([title]);
    const reviewed = reviewCandidates(
      candidateResponse([numberCandidate(local, '売上高', 900)], pages, 'earnings'),
      'earnings',
      pages
    );
    expect(reviewed.unverified).toEqual([]);
    expect(reviewed.facts.map((fact) => fact.value)).toEqual([900]);
    const display = buildPresentation(
      { version: 6, documentType: 'earnings', facts: reviewed.facts, unverified: [] },
      pages
    );
    expect(display.excerpts.some((excerpt) => excerpt.text === mixed)).toBe(true);
    expect(earningsTarget(display.excerpts).issue).toBe('subject');
    expect(display.overview).toEqual([]);
    expect(display.sections.flatMap((section) => section.factIds)).toEqual([reviewed.facts[0].id]);
  }
});

function forecast(first: ExtractedPage, fields: string[]) {
  const page = cells(
    [
      ['1. 2027年3月期連結業績予想の修正', 0, 0, 460],
      ...fields.map((text, i): [string, number, number, number] => [text, 0, 30 + i * 30, 300]),
      ['売上高', 400, 130, 80],
      ['営業利益', 600, 130, 80],
      ['百万円', 410, 160, 60],
      ['百万円', 610, 160, 60],
      ['前回予想', 0, 190, 300],
      ['100', 410, 190, 30],
      ['10', 610, 190, 30],
      ['修正後予想', 0, 220, 300],
      ['200', 410, 220, 30],
      ['20', 610, 220, 30],
    ],
    2
  );
  const pages = [first, page];
  const quantity = page.quantities.find((q) => q.text === '200')!;
  const mapping = buildDocumentContext(pages).tableMappings.find((m) => m.valueId === quantity.id)!;
  expect(mapping).toBeDefined();
  const input = tableAmount(pages, mapping, {
    subject: issuer,
    scope: '連結',
    basis: '日本基準',
    period: '2027年3月期',
    state: 'forecastAfter',
  });
  const reviewed = reviewCandidates(
    candidateResponse([input], pages, 'earnings'),
    'earnings',
    pages
  );
  expect(reviewed.unverified).toEqual([]);
  expect(reviewed.facts).toHaveLength(1);
  expect(reviewed.facts[0].value).toBe(200);
  return { pages, facts: reviewed.facts };
}

// The shared ownership boundary owns these cases; the headline contract suite owns
// the issuer/scope/basis selection matrix and source-backed save/restore behavior.
it('表紙の日付・連絡欄は通し、値や未見出し本文を越えて属性を借りない', () => {
  const initial = [
    cover,
    '2026年10月8日',
    `会社名 ${issuer}`,
    'コード番号 1234',
    'TEL 03-0000-0000',
    'URL https://example.com/report%20list',
  ];
  const fields = ['会計基準 日本基準', '範囲 連結'];
  for (const boundary of [null, '参考情報', '参考資料です。', '売上高は10百万円です。']) {
    const page = textPage(
      [
        ...initial,
        ...(boundary ? [boundary] : []),
        ...fields,
        '1. 2026年3月期連結経営成績',
        '営業利益は100百万円です。',
      ].join('\n')
    );
    const context = buildDocumentContext([page]);
    const selected = reportingCoverBlocks(page.blocks).map((block) => block.text);
    expect(selected).toEqual(boundary ? initial : [...initial, ...fields]);
    expect(documentSubject(context)).toBe(issuer);
    const basis = page.blocks.find((block) => block.text === fields[0])!;
    expect(
      isReportingCoverField(context.bindings.find((b) => b.anchorId === basis.id)!, [page])
    ).toBe(boundary === null);
    const reviewed = reviewCandidates(
      candidateResponse([numberCandidate(page)], [page], 'earnings'),
      'earnings',
      [page]
    );
    expect(reviewed.unverified).toEqual([]);
    expect(reviewed.facts).toHaveLength(1);
    const target = earningsTarget(sourceInventory([page], context, 'earnings'));
    expect(target.target?.basis).toBe(boundary ? null : '日本基準');
    const operating = coverageReport('earnings', [page], reviewed.facts).find(
      (slot) => slot.requirement === 'COVERAGE:当年決算実績の重要指標 operatingProfit'
    )!;
    expect(operating.expected?.basis ?? null).toBe(boundary ? null : '日本基準');
    const display = buildPresentation(
      { version: 6, documentType: 'earnings', facts: reviewed.facts, unverified: [] },
      [page]
    );
    expect(display.overview).toHaveLength(boundary ? 0 : 1);
  }
});

it('予想の独立した会社・範囲宣言を最初の値とせず、本文開始後の属性は借りない', () => {
  for (const text of [`会社名 ${issuer} 売上高100百万円`, `会社名 ${issuer} 売上高（百万円）1000`])
    expect(isReportingMetadata({ id: 'p1b1', text })).toBe(false);
  const first = textPage(`${cover}\n会社名 ${issuer}`);
  for (const field of [
    `会社名 ${issuer}`,
    issuer,
    '(連結)',
    '2026年5月10日 │ 決算説明会開催の有無：有',
    '参考情報',
  ]) {
    const { pages, facts } = forecast(first, [field, '会計基準 日本基準']);
    expect([...declaredForecastFactIds(pages, facts)]).toEqual(
      field === '参考情報' ? [] : [facts[0].id]
    );
  }
});

it('実績値の後の会社欄を発行会社へ昇格させず、その会社の予想も冒頭対象にしない', () => {
  const late = textPage(`${cover}\n売上高は1,000百万円です。\n参考会社情報\n会社名 ${issuer}`);
  const { pages, facts } = forecast(late, [`会社名 ${issuer}`, '会計基準 日本基準']);
  expect(documentSubject(buildDocumentContext(pages))).toBeNull();
  expect([...declaredForecastFactIds(pages, facts)]).toEqual([]);
  expect(
    buildPresentation({ version: 6, documentType: 'earnings', facts, unverified: [] }, pages)
      .overview
  ).toEqual([]);
  // The stricter earnings cover must not remove supported non-earnings title ordering.
  const other = textPage(
    `2026年10月8日\n各位\n自己株式取得に関するお知らせ\n会社名 ${issuer}\n取得株式数は100株です。`
  );
  expect(documentSubject(buildDocumentContext([other]))).toBe(issuer);
});

it('メタデータの投影で捨てた本文セル・同じ行の値を無視して後の会社名を借りない', () => {
  const title = '2026年3月期 決算短信〔日本基準〕（連結）';
  for (const suffix of ['売上高（百万円） | 1000', '参考情報']) {
    const mixed = `範囲 | 連結 | ${suffix}`;
    expect(reportingFieldSegments(mixed)).toEqual(['範囲 連結']);
    expect(reportingFieldProjection(mixed)).toEqual({ segments: ['範囲 連結'], complete: false });
    for (const layout of ['separated', 'physical'] as const) {
      const first =
        layout === 'separated'
          ? textPage(`${title}\n${mixed}\n会社名 ${issuer}`)
          : cells(
              [
                [title, 0, 0, 460],
                ...mixed
                  .split(' | ')
                  .map((text, i): [string, number, number, number] => [
                    text,
                    i * 180,
                    30,
                    Math.min(text.length * 10, 150),
                  ]),
                [`会社名 ${issuer}`, 0, 60, 220],
              ],
              1
            );
      const local = textPage(
        `会社名 ${issuer}\n1. 2026年3月期連結経営成績\n会計基準 日本基準\n2026年3月期の売上高は900百万円です。`,
        2
      );
      const pages = [first, local];
      const context = buildDocumentContext(pages);
      expect(documentSubject(context)).toBeNull();
      expect(reportingCoverBlocks(first.blocks).map((block) => block.text)).toEqual([title]);
      expect(isReportingMetadata(first.blocks[1])).toBe(false);
      const reviewed = reviewCandidates(
        candidateResponse([numberCandidate(local, '売上高', 900)], pages, 'earnings'),
        'earnings',
        pages
      );
      expect(reviewed.unverified).toEqual([]);
      expect(reviewed.facts.map((fact) => fact.value)).toEqual([900]);
      const display = buildPresentation(
        { version: 6, documentType: 'earnings', facts: reviewed.facts, unverified: [] },
        pages
      );
      expect(display.overview).toEqual([]);
      expect(display.sections.flatMap((section) => section.factIds)).toEqual([
        reviewed.facts[0].id,
      ]);
    }
  }
  for (const text of ['代表者に関する説明', 'コード番号に関する説明', `${title}\n参考情報`]) {
    expect(isReportingMetadata({ id: 'p1b2', text })).toBe(false);
    const page = textPage(`${title}\n${text}\n会社名 ${issuer}`);
    expect(documentSubject(buildDocumentContext([page]))).toBeNull();
  }
  // The real cover groups these three independently spaced labels into one block.
  const source =
    '上 場 会 社名 株式会社テスト 上場取引所 東\nコ ー ド 番号 1234 URL https://example.com/\n代 表 者 (役職名) 社長 (氏名) 山田 太郎';
  expect(reportingFieldProjection(source).complete).toBe(true);
  expect(isReportingMetadata({ id: 'p1b3', text: source })).toBe(true);
  expect(isReportingMetadata({ id: 'p1b4', text: '上場取引所 東' })).toBe(true);
  for (const text of ['コード番号 464A URL https://example.com/', '証券コード 123B']) {
    expect(isReportingMetadata({ id: 'p1b5', text })).toBe(true);
    expect(isReportingMetadata({ id: 'p1b5', text: `${text} 発行済株式数100株` })).toBe(false);
  }
});

it('会社欄と同じブロックに折返された総会日程ラベルで発行会社の境界を失わない', () => {
  const title = '2026年3月期 決算短信〔日本基準〕（連結）';
  const schedule = '定時株主総会（継続会）';
  const source = {
    id: 'p1b2',
    kind: 'paragraph' as const,
    text: `上 場 会 社名 ${issuer} 上場取引所 東\n代 表 者 (氏名) 山田 太郎\n${schedule}`,
  };
  const following = [
    '2026年10月30日 配当支払開始予定日 ―',
    '開催予定日',
    '有価証券報告書提出予定日2026年9月30日',
  ].map((text, i) => ({ id: `p1b${i + 3}`, text, kind: 'paragraph' as const }));
  const blocks = [{ id: 'p1b1', text: title, kind: 'paragraph' as const }, source, ...following];
  expect(reportingCoverBlocks(blocks)).toEqual(blocks);
  expect(isReportingMetadata(source)).toBe(true);
  expect(isReportingMetadata({ ...source, text: source.text + 'の参考情報' })).toBe(false);
  const page = textPage(
    `${title}\n会社名 ${issuer}\n${schedule}\n2026年10月30日 配当支払開始予定日 ―\n開催予定日\n1. 2026年3月期連結経営成績\n売上高は100百万円です。`
  );
  expect(documentSubject(buildDocumentContext([page]))).toBe(issuer);
  expect(earningsTarget(sourceInventory([page], undefined, 'earnings')).target).toMatchObject({
    subject: issuer,
    basis: '日本基準',
  });
});

it('表題セルの外の不明な範囲・基準・本文を表紙属性へ昇格させない', () => {
  const title = '2026年3月期 決算短信〔日本基準〕（連結）';
  for (const suffix of ['参考情報', '売上高100百万円', '(個別)', '〔IFRS〕']) {
    for (const separator of suffix.startsWith('(') || suffix.startsWith('〔')
      ? [' │ ']
      : [' │ ', ' ']) {
      const source = `${title}${separator}${suffix}`;
      const page = textPage(`${source}\n会社名 ${issuer}`);
      expect(reportingCoverBlocks(page.blocks)).toEqual([]);
      expect(documentSubject(buildDocumentContext([page]))).toBeNull();
      expect(earningsTarget(sourceInventory([page], undefined, 'earnings')).target).toBeNull();
    }
  }
  const compact = textPage(`${title} 2026年5月10日\n会社名 ${issuer}`);
  expect(documentSubject(buildDocumentContext([compact]))).toBe(issuer);
  expect(earningsTarget(sourceInventory([compact], undefined, 'earnings')).target).toMatchObject({
    subject: issuer,
    scope: '連結',
    basis: '日本基準',
  });
  const dateFirst = cells(
    [
      ['2026年5月10日', 0, 0, 480],
      [`${title} 参考情報`, 0, 15, 480],
      [`会社名 ${issuer}`, 0, 45, 210],
    ],
    1
  );
  expect(dateFirst.blocks[0].text).toContain('\n');
  expect(documentSubject(buildDocumentContext([dateFirst]))).toBeNull();
});

it('年のない完全な表題は経営成績の明示対象期への既存の照合を妨げない', () => {
  const page = textPage(
    `決算短信\n会社名 ${issuer}\n範囲 連結\n会計基準 日本基準\n1. 2026年3月期連結経営成績\n売上高は100百万円です。`
  );
  expect(earningsTarget(sourceInventory([page], undefined, 'earnings'))).toMatchObject({
    issue: null,
    target: { fiscal: '2026年3月期', subject: issuer, scope: '連結', basis: '日本基準' },
  });
});
