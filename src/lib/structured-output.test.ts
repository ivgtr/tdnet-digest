import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateText } from './llm-client';
import {
  buildJsonRepairMessages,
  getProviderCapabilities,
  parseAndValidateExtraction,
} from './structured-output';

function validDividend(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: '増配を発表した。',
    dividendDetails: {},
    investmentView: {
      shortTerm: { stance: 'positive', rationale: [{ text: '増配', page: 1 }] },
      mediumTerm: { stance: 'neutral', rationale: [] },
      longTerm: { stance: 'unknown', rationale: [] },
      positives: [{ text: '年間配当を増額', page: 1 }],
      risks: [],
      watchPoints: [],
      rationale: '増配は好材料だが長期影響は判断不能。',
    },
    topics: [],
    ...overrides,
  };
}

function validEarnings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: '決算要約',
    performance: { periodLabel: '通期実績', items: [] },
    dividend: null,
    earningsQuality: {
      operatingMargin: null,
      coreEarnings: null,
      oneOffItems: [],
      operatingCashFlow: null,
      financialHealth: [],
      capitalActions: [],
    },
    investmentView: validDividend().investmentView,
    topics: [],
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('プロバイダー能力', () => {
  it('OpenAIだけ既知のJSON objectモードを有効にする', () => {
    expect(getProviderCapabilities('openai').jsonObject).toBe(true);
    expect(getProviderCapabilities('anthropic').jsonObject).toBe(false);
    expect(getProviderCapabilities('custom').jsonObject).toBe(false);
  });

  it('JSON object指定時だけOpenAI互換リクエストへresponse_formatを付ける', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: '{}' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateText(
      {
        provider: 'openai',
        apiKey: 'test',
        model: 'test-model',
        responseFormat: 'json_object',
      },
      [{ role: 'user', content: 'JSONで返す' }]
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('抽出JSON検証', () => {
  it('コードブロックを除去して有効な抽出結果を受理する', () => {
    const text = `\`\`\`json\n${JSON.stringify(validDividend())}\n\`\`\``;
    const result = parseAndValidateExtraction(text, 'dividend', 2);
    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
  });

  it('文書固有の必須フィールド欠落を拒否する', () => {
    const result = parseAndValidateExtraction(
      JSON.stringify(validDividend({ dividendDetails: undefined })),
      'dividend',
      2
    );
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('dividendDetails');
  });

  it('不正な方向性、件数超過、PDF範囲外ページを拒否する', () => {
    const value = validDividend();
    const view = value.investmentView as Record<string, unknown>;
    view.shortTerm = { stance: 'veryPositive', rationale: [{ text: '根拠', page: 9 }] };
    view.positives = [
      { text: 'a', page: 1 },
      { text: 'b', page: 1 },
      { text: 'c', page: 1 },
    ];

    const result = parseAndValidateExtraction(JSON.stringify(value), 'dividend', 2);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('許可値');
    expect(result.errors.join(' ')).toContain('最大2件');
    expect(result.errors.join(' ')).toContain('PDF範囲外');
  });

  it('修復指示には検証エラーと壊れた応答だけを渡す', () => {
    const messages = buildJsonRepairMessages('{broken}', ['summaryがありません'], '{schema}');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toContain('{schema}');
    expect(messages[1].content).toContain('summaryがありません');
    expect(messages[1].content).toContain('{broken}');
    expect(messages[1].content).not.toContain('[PDF_PAGE:');
  });

  it('決算の意味分類に許可されていない値を拒否する', () => {
    const value = validEarnings();
    const quality = value.earningsQuality as Record<string, unknown>;
    quality.operatingCashFlow = {
      status: 'omittedMaybe',
      amount: null,
      confidence: 'certain',
      page: 1,
    };
    const result = parseAndValidateExtraction(JSON.stringify(value), 'earnings', 2);
    expect(result.success).toBe(false);
    expect(result.errors.join(' ')).toContain('operatingCashFlow.status');
    expect(result.errors.join(' ')).toContain('operatingCashFlow.confidence');
  });
});
