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
