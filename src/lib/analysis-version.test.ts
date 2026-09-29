import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SCHEMA_VERSION,
  buildAnalysisFingerprint,
  buildSummaryCacheKey,
} from './analysis-version';

describe('分析バージョン付きキャッシュキー', () => {
  it('要約仕様・モデル・抽出方式を含む', () => {
    const fingerprint = buildAnalysisFingerprint({
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash',
      extractionMode: 'full',
    });
    expect(fingerprint).toBe(
      `v${ANALYSIS_SCHEMA_VERSION}:openrouter:deepseek%2Fdeepseek-v4.1-flash:full`
    );
    expect(buildSummaryCacheKey('20260714.pdf', fingerprint)).toBe(`${fingerprint}:20260714.pdf`);
  });

  it('設定が変わると別のキャッシュになる', () => {
    const base = {
      provider: 'openrouter',
      model: 'deepseek/deepseek-v4.1-flash',
      extractionMode: 'full' as const,
    };
    expect(buildAnalysisFingerprint(base)).not.toBe(
      buildAnalysisFingerprint({ ...base, model: 'deepseek/deepseek-v4-flash' })
    );
    expect(buildAnalysisFingerprint(base)).not.toBe(
      buildAnalysisFingerprint({ ...base, extractionMode: 'smart' })
    );
  });
});
