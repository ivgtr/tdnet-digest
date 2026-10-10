import { describe, expect, it } from 'vitest';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { parseFactSummary } from './fact-summary';
import {
  buildPresentation,
  revalidatePresentation,
  validatePresentation,
} from './summary-presentation';
import { buildAnalysisInput } from './analysis-input';
import {
  analysisModelInput,
  parseAnalysis,
  parseAnalysisResponse,
  assertAnalysisInputBudget,
  ANALYSIS_INPUT_LIMITS,
} from './additional-analysis';
import { buildSourceLedger } from './source-ledger';
import { sameSourceLedgerContent } from './source-ledger-identity';
import { extractPageLayout } from './pdf-layout';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';

const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。\n未知の独自利益段階は70百万円です。\n会社は需要減速の可能性を説明しています。'
);
const facts = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'other',
    facts: [numberCandidate(page)],
    unverified: [],
  }),
  'other',
  [page]
);

describe('原資料台帳から分析・保存までの境界', () => {
  it('選択方針だけを同一性比較から外し、本文・配置・状態・目印の変更は拒否する', () => {
    const blank = { ...textPage('', 2), selection: 'omitted' as const };
    const original = buildSourceLedger([page, blank]);
    const full = buildSourceLedger([page, { ...blank, selection: 'selected' }]);
    expect(sameSourceLedgerContent(original, full)).toBe(true);
    const presentation = buildPresentation(facts, [page, blank]);
    const restored = revalidatePresentation(presentation, facts, [
      page,
      { ...blank, selection: 'selected' },
    ]);
    expect(restored).toBe(presentation);
    expect(
      buildAnalysisInput(facts, restored, [page, { ...blank, selection: 'selected' }]).inputHash
    ).toBe(buildAnalysisInput(facts, presentation).inputHash);
    for (const change of [
      (p: typeof page) => {
        p.text += '変更';
      },
      (p: typeof page) => {
        p.spans[0].x += 1;
      },
      (p: typeof page) => {
        p.status = 'failed';
      },
    ]) {
      const changed = structuredClone(page);
      change(changed);
      expect(sameSourceLedgerContent(original, buildSourceLedger([changed, blank]))).toBe(false);
    }
    const broken = structuredClone(original);
    broken.pages[1].selection = 'selected';
    expect(() => sameSourceLedgerContent(broken, full)).toThrow('SOURCE_LEDGER');
  });

  it('回転文字だけのページを原文として読めて引用・保存でき、空ページや検算値としない', () => {
    const rotated = extractPageLayout(
      [
        {
          str: '回転した指標 777百万円',
          transform: [0, 10, -10, 0, 100, 700],
          width: 80,
          height: 10,
          dir: 'ltr',
          hasEOL: false,
          fontName: 'fixture',
        } as TextItem,
      ],
      2
    );
    const presentation = buildPresentation(facts, [page, rotated]);
    const input = buildAnalysisInput(facts, presentation, [page, rotated]);
    const raw = input.evidence.find((e) => e.id === `rawitem:${rotated.sourceItems[0].id}`)!;
    expect(raw.text).toBe('回転した指標 777百万円');
    expect(raw.kind).toBe('source');
    expect(input.sourceDocument!.pages[1].originalItems[0][1]).toBe(raw.text);
    expect(input.coverage.sourceLedger!.emptyPages).not.toContain(2);
    expect(input.coverage.calculations).toBe(0);
    const result = parseAnalysisResponse(
      JSON.stringify({
        version: 4,
        issues: [
          {
            title: '原文の対応を確認',
            conclusion: '原文の記載は読める。',
            reading: '指標の期間と対象への対応は未点検。',
            caveat: '',
            nextCheck: '',
            evidenceIds: [raw.id],
          },
        ],
      }),
      input
    );
    expect(parseAnalysis(JSON.stringify(result), facts, presentation).evidence).toEqual([raw]);
  });

  it('全文の入力予算は文字数とUTF-8容量の両方で境界を確認し、切り捨てない', () => {
    const messages = [{ content: 'a'.repeat(ANALYSIS_INPUT_LIMITS.characters) }];
    expect(() => assertAnalysisInputBudget(messages)).not.toThrow();
    expect(() => assertAnalysisInputBudget([...messages, { content: 'a' }])).toThrow(
      '原文を省略せず'
    );
    const unicode = [{ content: 'あ'.repeat(Math.floor(ANALYSIS_INPUT_LIMITS.bytes / 3) + 1) }];
    expect(unicode[0].content.length).toBeLessThan(ANALYSIS_INPUT_LIMITS.characters);
    expect(() => assertAnalysisInputBudget(unicode)).toThrow('実行上限');
    expect(messages[0].content.length).toBe(ANALYSIS_INPUT_LIMITS.characters);
  });

  it('本文行に束ねられなかった文字セルにも意味未点検の引用先を残す', () => {
    const loose = textPage('未対応の指標 77百万円', 2);
    loose.blocks = [];
    const input = buildAnalysisInput(facts, buildPresentation(facts, [page, loose]));
    const literal = input.evidence.find((e) => e.id === `rawspan:${loose.spans[0].id}`)!;
    expect(literal.kind).toBe('source');
    expect(literal.text).toBe(loose.spans[0].text);
    expect(analysisModelInput(input).allowedEvidenceIds).toContain(literal.id);
    expect(input.sourceDocument?.pages[1].looseSpans[0][0]).toBe(loose.spans[0].id);
  });

  it('要約未選択の原文を別種別で渡し、計算や照合済み事実へ昇格させない', () => {
    const presentation = buildPresentation(facts, [page]);
    const input = buildAnalysisInput(facts, presentation, [page]);
    const raw = input.evidence.find(
      (e) => e.kind === 'source' && e.text.includes('未知の独自利益')
    )!;
    expect(raw).toBeDefined();
    expect(input.evidence.filter((e) => e.kind === 'fact')).toHaveLength(1);
    expect(input.evidence.filter((e) => e.kind === 'calculation')).toHaveLength(0);
    expect(input.coverage.sourceLedger?.rows).toBe(page.blocks.length);
    const projected = analysisModelInput(input);
    expect(projected.allowedEvidenceIds).toContain(raw.id);
    expect(JSON.stringify(projected.sourceDocument)).toContain('未知の独自利益');
    const alteredSelection = { ...presentation, overview: [] };
    expect(buildAnalysisInput(facts, alteredSelection).sourceDocument).toEqual(
      input.sourceDocument
    );
    expect(buildAnalysisInput(facts, alteredSelection).inputHash).toBe(input.inputHash);
    const result = parseAnalysisResponse(
      JSON.stringify({
        version: 4,
        issues: [
          {
            title: '需要減速に注意',
            conclusion: '会社の説明には減速への留意点がある。',
            reading: '需要の継続性には条件が残る。',
            caveat: '',
            nextCheck: '',
            evidenceIds: [raw.id],
          },
        ],
      }),
      input
    );
    expect(parseAnalysis(JSON.stringify(result), facts, presentation)).toEqual(result);
    expect(result.evidence).toEqual([raw]);
    const removed = structuredClone(presentation);
    delete removed.sourceLedger;
    expect(() => parseAnalysis(JSON.stringify(result), facts, removed)).toThrow();
  });

  it('整合する台帳でも別PDFの内容は再抽出照合で拒否する', () => {
    const original = buildPresentation(facts, [page]);
    validatePresentation(original, facts);
    const changedPage = structuredClone(page);
    changedPage.text += '\n追加された別原文';
    const forged = { ...original, sourceLedger: buildSourceLedger([changedPage]) };
    expect(() => validatePresentation(forged, facts)).toThrow();
    expect(() => revalidatePresentation(original, facts, [changedPage])).toThrow();
    expect(() => buildAnalysisInput(facts, original, [changedPage])).toThrow();
  });

  it('未読・空ページは明示し、資料の不存在と扱わない', () => {
    const failed = { ...textPage('', 2), status: 'failed' as const };
    const empty = { ...textPage('', 3), status: 'empty' as const };
    const input = buildAnalysisInput(facts, buildPresentation(facts, [page, failed, empty]));
    expect(input.coverage.sourceLedger?.failedPages).toEqual([2]);
    expect(input.coverage.sourceLedger?.emptyPages).toEqual([3]);
    expect(input.sourceDocument?.coverage.pages).toBe(3);
  });
});
