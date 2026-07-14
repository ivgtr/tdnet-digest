import { describe, expect, it } from 'vitest';
import { buildMetadataHtml } from './summaryHtmlBuilder';

describe('分析メタデータ表示', () => {
  it('分析条件を表示しモデル名をHTMLエスケープする', () => {
    const html = buildMetadataHtml({
      totalPages: 3,
      extractedPages: [1, 2, 3],
      extractionMode: 'full',
      provider: 'custom',
      model: '<model>',
      summaryMode: 'two-pass',
      analysisSchemaVersion: 7,
    });
    expect(html).toContain('custom/&lt;model&gt;・2パス・v7');
    expect(html).not.toContain('custom/<model>');
  });
});
