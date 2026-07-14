import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SCHEMA_VERSION,
  buildAnalysisFingerprint,
  buildSummaryCacheKey,
} from './analysis-version';

describe('分析バージョン付きキャッシュキー', () => {
  it('分析仕様・モデル・抽出方式・パス方式を含む', () => {
    const fingerprint = buildAnalysisFingerprint({
      provider: 'openrouter',
      model: 'google/gemini flash',
      extractionMode: 'full',
      twoPassMode: true,
      experimentalScoring: false,
    });
    expect(fingerprint).toBe(
      `v${ANALYSIS_SCHEMA_VERSION}:openrouter:google%2Fgemini%20flash:full:two-pass:score-off`
    );
    expect(buildSummaryCacheKey('20260714.pdf', fingerprint)).toBe(`${fingerprint}:20260714.pdf`);
  });

  it('設定が変わると別のキャッシュになる', () => {
    const base = {
      provider: 'openai',
      model: 'gpt-4o',
      extractionMode: 'full' as const,
      twoPassMode: true,
      experimentalScoring: false,
    };
    expect(buildAnalysisFingerprint(base)).not.toBe(
      buildAnalysisFingerprint({ ...base, model: 'gpt-4o-mini' })
    );
    expect(buildAnalysisFingerprint(base)).not.toBe(
      buildAnalysisFingerprint({ ...base, twoPassMode: false })
    );
    expect(buildAnalysisFingerprint(base)).not.toBe(
      buildAnalysisFingerprint({ ...base, experimentalScoring: true })
    );
  });
});
