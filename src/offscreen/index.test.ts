import { afterEach, expect, it, vi } from 'vitest';

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
