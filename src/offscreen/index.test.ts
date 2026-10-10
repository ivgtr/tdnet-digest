import { afterEach, expect, it, vi } from 'vitest';
import type { PdfExtractionErrorDetails } from '../lib/pdf-extraction-error';

const pdfjs = vi.hoisted(() => ({ getDocument: vi.fn(), GlobalWorkerOptions: { workerSrc: '' } }));
vi.mock('pdfjs-dist', () => ({ ...pdfjs, OPS: {} }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/assets/pdf.worker.test.mjs',
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.clearAllMocks();
});

it('loads packed CMaps from the extension for an Offscreen extraction request', async () => {
  const addListener = vi.fn();
  const getURL = vi.fn((path: string) => `chrome-extension://test-extension/${path}`);
  vi.stubGlobal('chrome', { runtime: { onMessage: { addListener }, getURL } });
  const page = {
    getTextContent: async () => ({
      items: [
        {
          str: '検証対象の本文',
          transform: [12, 0, 0, 12, 20, 700],
          width: 84,
          height: 12,
          dir: 'ltr',
          hasEOL: true,
        },
      ],
    }),
    getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
    cleanup: vi.fn(),
  };
  pdfjs.getDocument.mockReturnValue({
    promise: Promise.resolve({ numPages: 1, getPage: async () => page, destroy: vi.fn() }),
  });
  await import('./index');
  const response = await new Promise<{ success: boolean; text: string }>((resolve) => {
    const listener = addListener.mock.calls[0][0];
    expect(listener({ action: 'extractPdfText', pdfData: [1, 2, 3] }, {}, resolve)).toBe(true);
  });

  expect(response.success).toBe(true);
  expect(response.text).toContain('検証対象の本文');
  expect(pdfjs.getDocument).toHaveBeenCalledWith({
    data: new Uint8Array([1, 2, 3]),
    cMapUrl: 'chrome-extension://test-extension/cmaps/',
    cMapPacked: true,
    useWorkerFetch: false,
    isEvalSupported: false,
    useSystemFonts: true,
  });
  expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe(
    'chrome-extension://test-extension/assets/pdf.worker.test.mjs'
  );
});

// The real page extractor owns stage tagging; only PDF.js input and Chrome transport are replaced.
it.each(['page-load', 'text-content', 'operator-list', 'page-layout'] as const)(
  'preserves the first failed page and %s cause without returning partial text',
  async (stage) => {
    const addListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener }, getURL: (path: string) => path },
    });
    const original = Object.assign(new Error('PDF.js page operation failed'), {
      name: 'InvalidPDFException',
      code: 17,
    });
    const page = {
      getTextContent: vi.fn(async () => ({
        items: [
          {
            str: '部分抽出だけでは要約しない',
            transform: [12, 0, 0, 12, 20, 700],
            width: 120,
            height: 12,
            dir: 'ltr',
            hasEOL: true,
          },
        ],
      })),
      getOperatorList: vi.fn(async () => ({ fnArray: [] as number[], argsArray: [] })),
      cleanup: vi.fn(),
    };
    const getPage = vi.fn(async (pageNumber: number) => {
      if (pageNumber === 2) {
        if (stage === 'page-load') throw original;
        if (stage === 'text-content') page.getTextContent.mockRejectedValueOnce(original);
        if (stage === 'operator-list') page.getOperatorList.mockRejectedValueOnce(original);
        if (stage === 'page-layout')
          page.getOperatorList.mockResolvedValueOnce({ fnArray: [999999], argsArray: [] });
      }
      return page;
    });
    const destroy = vi.fn().mockRejectedValue(new Error('later cleanup failure'));
    pdfjs.getDocument.mockReturnValue({
      promise: Promise.resolve({ numPages: 3, getPage, destroy }),
    });
    await import('./index');
    const response = await new Promise<{
      success: boolean;
      error: string;
      pdfExtractionError: PdfExtractionErrorDetails;
    }>((resolve) =>
      addListener.mock.calls[0][0]({ action: 'extractPdfText', pdfData: [] }, {}, resolve)
    );

    expect(response.success).toBe(false);
    expect(response).not.toHaveProperty('text');
    expect(response).not.toHaveProperty('pages');
    const originalDetails =
      stage === 'page-layout'
        ? {
            name: 'Error',
            code: 'SOURCE_DRAWING',
            message: 'SOURCE_DRAWING:PDF.jsの未知の描画演算',
          }
        : { name: original.name, code: original.code, message: original.message };
    expect(JSON.parse(JSON.stringify(response)).pdfExtractionError).toEqual({
      pageNumber: 2,
      stage,
      ...originalDetails,
    });
    expect(response.error).toBe(`PDF抽出エラー: PDF p.2: ${originalDetails.message}`);
    expect(getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2]);
    expect(destroy).toHaveBeenCalledTimes(1);
  }
);

it('preserves a document-load failure before any page is available', async () => {
  const addListener = vi.fn();
  vi.stubGlobal('chrome', {
    runtime: { onMessage: { addListener }, getURL: (path: string) => path },
  });
  pdfjs.getDocument.mockImplementation(() => ({
    promise: Promise.reject(
      Object.assign(new Error('Invalid PDF structure'), { name: 'InvalidPDFException' })
    ),
  }));
  await import('./index');
  const response = await new Promise((resolve) =>
    addListener.mock.calls[0][0]({ action: 'extractPdfText', pdfData: [] }, {}, resolve)
  );
  expect(response).toEqual({
    success: false,
    error: 'PDF抽出エラー: Invalid PDF structure',
    pdfExtractionError: {
      pageNumber: null,
      stage: 'document-load',
      name: 'InvalidPDFException',
      code: null,
      message: 'Invalid PDF structure',
    },
  });
});

it.each(['full', 'smart'])(
  '%s keeps rotated-only source pages and reports mapping limits separately from empty pages',
  async (extractionMode) => {
    const addListener = vi.fn();
    vi.stubGlobal('chrome', {
      runtime: { onMessage: { addListener }, getURL: (path: string) => path },
    });
    pdfjs.getDocument.mockReturnValue({
      promise: Promise.resolve({
        numPages: 2,
        getPage: async (pageNumber: number) => ({
          getTextContent: async () => ({
            items: [
              {
                str: pageNumber === 1 ? '回転した原文100百万円' : '　',
                transform: [0, 12, -12, 0, 20, 700],
                width: 84,
                height: 12,
                dir: 'ltr',
                hasEOL: true,
              },
            ],
          }),
          getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
          cleanup: vi.fn(),
        }),
        destroy: vi.fn(),
      }),
    });
    await import('./index');
    const response = await new Promise<{
      success: boolean;
      text: string;
      pages: import('../types/summaryMetadata').ExtractedPage[];
      metadata: import('../types/summaryMetadata').SummaryMetadata;
    }>((resolve) =>
      addListener.mock.calls[0][0](
        { action: 'extractPdfText', pdfData: [], extractionMode },
        {},
        resolve
      )
    );
    expect(response.success).toBe(true);
    expect(response.text).toContain('回転した原文100百万円');
    expect(response.pages.map((page) => page.status)).toEqual(['ok', 'empty']);
    expect(response.pages[0].spans).toEqual([]);
    expect(response.metadata.qualityWarning?.message).toContain('文字を取得できないページ: 2');
    expect(response.metadata.qualityWarning?.message).toContain('回転文字を含むページ: 1');
    expect(response.metadata.qualityWarning?.message).toContain('表セルへの対応付けは未対応');
    expect(response.metadata.qualityWarning?.message).not.toContain('画像・回転表等は未対応');
  }
);
