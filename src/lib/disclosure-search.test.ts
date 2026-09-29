import { describe, expect, it, vi } from 'vitest';
import {
  fetchCandidatePdf,
  searchDisclosureCandidates,
  validCandidateUrl,
} from './disclosure-search';

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

  it('検索本文にある許可済みPDFだけを取り、メタデータ中のURLを無視する', async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content:
                'https://www2.jpx.co.jp/disc/12340/140120250509536933.pdf https://issuer.example/ir/old.pdf',
            },
          },
        ],
        citation: { url: 'https://pdf.irpocket.com/C1234/ab/CD/ef.pdf' },
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
    expect(result.urls).toEqual(['https://www2.jpx.co.jp/disc/12340/140120250509536933.pdf']);
    expect(result.requests).toBe(1);
    expect(result.apiRequests).toBe(1);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.body).toContain('ssl4.eir-parts.net');
    vi.unstubAllGlobals();
  });

  it.each([
    [
      'openai',
      {
        output: [
          { type: 'web_search_call', url: 'https://issuer.example/old.pdf' },
          {
            type: 'message',
            content: [
              {
                type: 'output_text',
                text: 'https://www2.jpx.co.jp/disc/12340/140120250509536933.pdf',
              },
            ],
          },
        ],
      },
    ],
    [
      'anthropic',
      {
        content: [
          { type: 'web_search_tool_result', url: 'https://issuer.example/old.pdf' },
          { type: 'text', text: 'https://www2.jpx.co.jp/disc/12340/140120250509536933.pdf' },
        ],
      },
    ],
    [
      'google',
      {
        candidates: [
          {
            content: {
              parts: [{ text: 'https://www2.jpx.co.jp/disc/12340/140120250509536933.pdf' }],
            },
          },
        ],
        groundingMetadata: { url: 'https://issuer.example/old.pdf' },
      },
    ],
  ] as const)('%sのモデル本文からだけ候補を読む', async (provider, data) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => data }))
    );
    const result = await searchDisclosureCandidates(
      { ...common, provider },
      '会社',
      '1234',
      '決算'
    );
    expect(result.urls).toEqual(['https://www2.jpx.co.jp/disc/12340/140120250509536933.pdf']);
    vi.unstubAllGlobals();
  });

  it('候補URLをホスト・企業領域・認証情報まで照合する', () => {
    expect(
      validCandidateUrl('https://www2.jpx.co.jp/disc/12340/140120250509536933.pdf', '1234')
    ).toBe(true);
    expect(
      validCandidateUrl('https://ssl4.eir-parts.net/doc/1234/tdnet/2824726/00.pdf', '1234')
    ).toBe(true);
    expect(validCandidateUrl('https://pdf.irpocket.com/C1234/NJLt/DlSE/GW3n.pdf', '1234')).toBe(
      true
    );
    for (const url of [
      'https://www2.jpx.co.jp.evil.example/disc/12340/140120250509536933.pdf',
      'https://www2.jpx.co.jp/disc/99990/140120250509536933.pdf',
      'https://ssl4.eir-parts.net/doc/9999/tdnet/2824726/00.pdf',
      'https://ssl4.eir-parts.net/doc/1234/announcement/2824726/00.pdf',
      'https://pdf.irpocket.com/C9999/NJLt/DlSE/GW3n.pdf',
      'https://user:secret@www2.jpx.co.jp/disc/12340/140120250509536933.pdf',
      'https://www2.jpx.co.jp/disc/12340/140120250509536933.pdf?token=1',
      'https://contents.xj-storage.jp/xcontents/AS1234/a.pdf',
    ])
      expect(validCandidateUrl(url, '1234')).toBe(false);
  });

  it('取得直前にもURLを検証する', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchCandidatePdf('https://issuer.example/ir/old.pdf', '1234')).rejects.toThrow(
      '取得対象外'
    );
    expect(fetcher).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
