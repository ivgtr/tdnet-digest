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
  for (const field of [`会社名 ${issuer}`, issuer, '(連結)', '参考情報']) {
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
