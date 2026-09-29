import { describe, expect, it, vi } from 'vitest';
import { searchDisclosureCandidates } from './disclosure-search';

const common = { apiKey: 'test', model: 'test' };

describe('過去開示候補の検索', () => {
  it('カスタムAPIは検索不可を明示する', async () => {
    const result = await searchDisclosureCandidates(
      { ...common, provider: 'custom' },
      '会社',
      '1234',
      '決算'
    );
    expect(result).toMatchObject({ urls: [], requests: 0, apiRequests: 0 });
    expect(result.status).toContain('利用できません');
  });

  it('検索結果からPDF候補だけを取り、回数を記録する', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [
          { message: { content: 'https://issuer.example/ir/old.pdf https://issuer.example/news' } },
        ],
        usage: { server_tool_use: { web_search_requests: 1 } },
      }),
    }));
    vi.stubGlobal('fetch', fetcher);
    const result = await searchDisclosureCandidates(
      { ...common, provider: 'openrouter' },
      '会社',
      '1234',
      '決算'
    );
    expect(result.urls).toEqual(['https://issuer.example/ir/old.pdf']);
    expect(result.requests).toBe(1);
    expect(result.apiRequests).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    vi.unstubAllGlobals();
  });
});
