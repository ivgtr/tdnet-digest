import { describe, expect, it } from 'vitest';
import { buildSourcePresentation } from './source-summary';
import { buildAnalysisInput } from './analysis-input';
import { analysisPrompt, parseAnalysisResponse, parseAnalysis } from './additional-analysis';
import { validatePresentation, revalidatePresentation } from './summary-presentation';
import { renderFacts } from './fact-summary';
import { validateSavedFacts } from './fact-cache';
import { textPage } from './fixtures/v4-test-source';
import { parseSummaryMarkdown } from '../content/utils/markdownParser';

const page = textPage('未知の独自指標は876百万円です。\n会社は今期の需要減速を説明しています。');
describe('direct source summary contract', () => {
  it('reads unknown original evidence with zero verified facts and roundtrips without fact-schema prerequisites', () => {
    const { facts, presentation } = buildSourcePresentation('earnings', [
      { ...page, selection: 'omitted' },
    ]);
    const input = buildAnalysisInput(facts, presentation);
    expect(facts.facts).toEqual([]);
    expect(presentation.values).toEqual([]);
    expect(input.sourceDocument?.pages).toHaveLength(1);
    expect(input.evidence.some((e) => e.text.includes('876'))).toBe(true);
    const id = input.evidence[0].id;
    presentation.sourceFirst!.summary = parseAnalysisResponse(
      JSON.stringify({
        version: 4,
        overallSummary: { text: '会社独自の指標と需要の変化が示された。', evidenceIds: [id] },
        issues: [
          {
            title: '独自指標',
            conclusion: '独自指標は876百万円。',
            reading: '会社の開示による。',
            caveat: '',
            nextCheck: '',
            evidenceIds: [id],
          },
        ],
      }),
      input
    );
    validateSavedFacts(facts);
    validatePresentation(presentation, facts);
    expect(
      parseAnalysis(JSON.stringify(presentation.sourceFirst!.summary), facts, presentation).issues
    ).toHaveLength(1);
    expect(revalidatePresentation(presentation, facts, [page])).toBe(presentation);
    const markdown = renderFacts(facts, presentation);
    expect(markdown.indexOf('会社独自の指標と需要')).toBeLessThan(markdown.indexOf('### 独自指標'));
    expect(
      parseSummaryMarkdown(markdown, 'https://www.release.tdnet.info/inbs/140120261008548129.pdf')
    ).toContain('class="tdnet-digest-source"');
    const changed = structuredClone(page);
    changed.spans[0].text = '別の数量';
    expect(() => revalidatePresentation(presentation, facts, [changed])).toThrow();
  });
  it('keeps long fallback diagnostics losslessly without invalidating a later successful result', () => {
    const warning = '原資料の取得診断'.repeat(200);
    const { facts, presentation } = buildSourcePresentation('other', [page], {
      warnings: [warning],
    });
    expect(presentation.sourceFirst!.warnings.join('')).toBe(warning);
    expect(() => validatePresentation(presentation, facts)).not.toThrow();
  });
  it('gives factual summary and investment analysis different instructions and examples', () => {
    const { facts, presentation } = buildSourcePresentation('other', [page]);
    const input = buildAnalysisInput(facts, presentation);
    const summary = analysisPrompt(input, 'summary');
    const analysis = analysisPrompt(input, 'analysis');
    expect(summary[1].content).toContain('今回発表された結果・変更');
    expect(summary[1].content).not.toContain('根拠をつないだ条件付きの読み');
    expect(analysis[0].content).toContain('いい決算か');
    expect(analysis[1].content).toContain('条件付きの読み');
  });
});
