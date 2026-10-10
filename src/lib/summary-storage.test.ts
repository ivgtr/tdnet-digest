import { describe, expect, it } from 'vitest';
import {
  decodeSummaryStorage,
  encodeSummaryStorage,
  isSummaryStorageEntry,
  summaryStorageWarning,
} from './summary-storage';
import type { CachedSummary } from '@/types/summaryMetadata';

const entry = (padding = '') =>
  ({
    summary: `確認済み要約${padding}`,
    companyName: 'テスト',
    title: '決算',
    code: '1234',
    cachedAt: 1,
    resultId: 'a'.repeat(64),
    facts: { version: 6, facts: [] },
    presentation: {},
    metadata: {},
  }) as unknown as CachedSummary;

describe('summary storage transport', () => {
  it('keeps small/legacy entries intact and losslessly compresses large Japanese source text', async () => {
    const small = entry();
    expect(await encodeSummaryStorage(small)).toBe(small);
    expect(await decodeSummaryStorage(small)).toBe(small);
    const large = entry('税引前利益 25,963百万円 前年同期25,204百万円\n'.repeat(15000));
    const encoded = await encodeSummaryStorage(large);
    expect(JSON.stringify(encoded).length).toBeLessThan(JSON.stringify(large).length / 4);
    expect(isSummaryStorageEntry(encoded)).toBe(true);
    expect(await decodeSummaryStorage(JSON.parse(JSON.stringify(encoded)))).toEqual(large);
  });

  it('rejects corrupted, truncated and oversized compressed payloads', async () => {
    const encoded = await encodeSummaryStorage(entry('根拠'.repeat(150000)));
    expect('payload' in encoded).toBe(true);
    await expect(decodeSummaryStorage({ ...encoded, resultId: 'other' })).rejects.toThrow(
      '識別情報'
    );
    await expect(decodeSummaryStorage({ ...encoded, payload: 'not base64!' })).rejects.toThrow();
    await expect(decodeSummaryStorage({ ...encoded, decodedBytes: 10 })).rejects.toThrow();
    await expect(
      decodeSummaryStorage({ ...encoded, decodedBytes: 33 * 1024 * 1024 })
    ).rejects.toThrow();
  });

  it('gives quota-specific next steps without presenting all failures as quota', () => {
    expect(summaryStorageWarning(new Error('QUOTA_BYTES quota exceeded'))).toContain(
      '要約キャッシュ管理'
    );
    expect(summaryStorageWarning(new Error('Extension context invalidated'))).toContain(
      '拡張機能が有効か'
    );
    expect(summaryStorageWarning(new Error('Serialization error'))).not.toContain('容量が不足');
  });
});
