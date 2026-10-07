import { createHash } from 'node:crypto';
import { configuredApiUrl } from './llm-endpoint';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_SCHEMA_VERSION,
  buildAnalysisFingerprint,
  buildSummaryCacheKey,
} from './analysis-version';

const settings = {
  provider: 'custom',
  model: 'namespace/fixture',
  baseUrl: 'https://api.example.com/v1/chat?deployment=a&token=private-token',
  extractionMode: 'full' as const,
};

describe('分析バージョン付きキャッシュキー', () => {
  it('仕様・モデル・抽出方式と実効URLのハッシュだけを含み、秘密値を残さない', async () => {
    const fingerprint = await buildAnalysisFingerprint(settings);
    expect(fingerprint).toBe(
      `v${ANALYSIS_SCHEMA_VERSION}:custom:namespace%2Ffixture:full:${createHash('sha256').update(settings.baseUrl).digest('hex')}`
    );
    expect(fingerprint).not.toContain('private-token');
    expect(fingerprint).not.toContain('api.example.com');
    expect(buildSummaryCacheKey('20260714.pdf', fingerprint)).toBe(`${fingerprint}:20260714.pdf`);
    const rotatedKey = { ...settings, apiKey: 'rotated-key' };
    expect(await buildAnalysisFingerprint(rotatedKey)).toBe(fingerprint);
  });

  it('モデル・抽出方式・URLの経路やqueryの違いを区別する', async () => {
    const fingerprint = await buildAnalysisFingerprint(settings);
    for (const update of [
      { model: 'other' },
      { extractionMode: 'smart' as const },
      { baseUrl: settings.baseUrl.replace('/chat?', '/chat/?') },
      { baseUrl: settings.baseUrl.replace('/v1/', '/v2/') },
      { baseUrl: settings.baseUrl.replace('deployment=a', 'deployment=b') },
      {
        baseUrl: settings.baseUrl.replace(
          '?deployment=a&token=private-token',
          '?token=private-token&deployment=a'
        ),
      },
    ])
      expect(await buildAnalysisFingerprint({ ...settings, ...update })).not.toBe(fingerprint);
  });

  it('fetchの同じURL表記は同一とし、標準プロバイダーのURL上書きも実効URLに含む', async () => {
    expect(
      await buildAnalysisFingerprint({
        ...settings,
        baseUrl:
          ' HTTPS://API.EXAMPLE.COM:443/x/../v1/chat?deployment=a&token=private-token#ignored ',
      })
    ).toBe(await buildAnalysisFingerprint(settings));
    expect(
      configuredApiUrl({ provider: 'openai', customUrl: 'https://unused.example/another' })
    ).toBe('https://unused.example/another');
    await expect(
      buildAnalysisFingerprint({
        ...settings,
        baseUrl: 'https://user:private-password@api.example.com/v1/chat',
      })
    ).rejects.toThrow('URLに認証情報を含めない');
    await expect(
      buildAnalysisFingerprint({ ...settings, baseUrl: 'private-invalid-url' })
    ).rejects.toThrow(/^API URLが不正です$/);
  });
});
