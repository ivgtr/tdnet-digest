import { describe, expect, it } from 'vitest';
import { buildMetadataHtml, buildSummaryHtml, buildScoreStageHtml } from './summaryHtmlBuilder';

describe('分析メタデータ表示', () => {
  it('分析条件を表示しモデル名をHTMLエスケープする', () => {
    const html = buildMetadataHtml({
      totalPages: 3,
      extractedPages: [1, 2, 3],
      extractionMode: 'full',
      provider: 'custom',
      model: '<model>',
      summaryMode: 'one-pass',
      analysisSchemaVersion: 7,
    });
    expect(html).toContain('custom/&lt;model&gt;・1回・v7');
    expect(html).not.toContain('custom/<model>');
  });
});

describe('要約下部の採点表示', () => {
  it('要約本文の後ろに採点失敗と再試行ボタンを表示する', () => {
    const html = buildSummaryHtml(
      '要約本文',
      null,
      { companyName: '会社', title: '開示' },
      {
        loading: false,
        data: null,
        error: '<失敗>',
      }
    );
    expect(html.indexOf('id="score-result"')).toBeGreaterThan(html.indexOf('要約本文'));
    expect(html).toContain('採点失敗: &lt;失敗&gt;');
    expect(html).toContain('id="retry-score-btn"');
  });
  it('採点中と採点無効時に再試行を表示しない', () => {
    expect(buildScoreStageHtml({ loading: true, data: null, error: null })).toBe('採点中…');
    expect(buildScoreStageHtml()).toBe('');
  });
});
