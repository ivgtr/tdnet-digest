// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AdditionalAnalysis } from '@/lib/additional-analysis';
import {
  buildMetadataHtml,
  buildSummaryHtml,
  buildScoreStageHtml,
  buildAnalysisStageHtml,
} from './summaryHtmlBuilder';

describe('分析メタデータ表示', () => {
  it('分析条件を表示しモデル名をHTMLエスケープする', () => {
    const html = buildMetadataHtml({
      totalPages: 3,
      extractedPages: [1, 2, 3],
      extractionMode: 'full',
      provider: 'custom',
      model: '<model>',
      summaryMode: 'sourced-summary',
      generationCalls: 3,
      analysisSchemaVersion: 7,
    });
    expect(html).toContain('custom/&lt;model&gt;・根拠照合＋説明要約・API3回・事実v7');
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

describe('追加分析の表示境界', () => {
  it.each([false, true])(
    '隔離理由を常時表示し、未検証の文章と根拠を分ける（全件隔離=%s）',
    (allQuarantined) => {
      const unsafe = '<img src=x onerror="alert(1)">';
      const issue = {
        title: `第2四半期の成長 ${unsafe}`,
        conclusion: `来期に999億円を見込む ${unsafe}`,
        evidenceIds: ['fact:verified'],
        reading: `AI事業が増益をもたらす ${unsafe}`,
        caveat: `情報が開示されていない ${unsafe}`,
        nextCheck: `2027年に確認する ${unsafe}`,
      };
      const data: AdditionalAnalysis = {
        version: 4,
        inputHash: 'fixture',
        candidates: [
          { ...issue, title: '隔離した本文は見せない', evidenceIds: ['missing'] },
          issue,
        ],
        issues: allQuarantined ? [] : [issue],
        notices: [
          {
            issueIndex: 0,
            severity: 'quarantined',
            code: 'evidence_unknown',
            path: '$.issues[0].evidenceIds',
            message: `根拠IDが不正 ${unsafe}`,
          },
          {
            issueIndex: -1,
            severity: 'warning',
            code: 'output_limit',
            path: '$',
            message: '出力上限で終了しました。内容が完結していない可能性があります',
          },
          allQuarantined
            ? {
                issueIndex: 1,
                severity: 'quarantined',
                code: 'issue_shape',
                path: '$.issues[1]',
                message: '形式が不正',
              }
            : {
                issueIndex: 1,
                severity: 'warning',
                code: 'text_length',
                path: '$.issues[1].conclusion',
                message: '文章が長い',
              },
        ],
        evidence: [
          {
            id: 'fact:verified',
            kind: 'fact',
            text: `売上100億円 ${unsafe}`,
            context: '<script>context</script>',
            pages: [2],
            sourceIds: ['source:<unsafe>'],
          },
        ],
        coverage: {
          facts: 1,
          explanations: 0,
          observations: 0,
          calculations: 0,
          pages: [2],
          organizationStatus: 'ready',
          unresolvedSources: 0,
          unverifiedFacts: 0,
          unverifiedItems: 0,
          unverifiedSourcePages: [],
          limitations: [],
        },
        usage: null,
      };
      const render = (pdfUrl: string) => {
        const root = document.createElement('div');
        root.innerHTML = buildAnalysisStageHtml({ loading: false, data, error: null }, [], pdfUrl);
        return root;
      };
      const root = render('https://www.release.tdnet.info/inbs/fixture.pdf');
      expect(root.querySelector('[data-analysis-boundary]')?.textContent).toContain(
        '数値、因果関係、情報がないという主張'
      );
      const notices = root.querySelector('[data-analysis-notices]')!;
      expect(notices.closest('details')).toBeNull();
      expect(notices.textContent).toContain('元の論点1・非表示: 根拠IDが不正');
      expect(notices.textContent).toContain('$.issues[0].evidenceIds');
      expect(notices.textContent).toContain('応答全体・注意: 出力上限で終了しました');
      expect(notices.textContent).not.toContain('元の論点0');
      expect(root.textContent).not.toContain('隔離した本文は見せない');
      expect(root.querySelectorAll('img,script,[onerror]')).toHaveLength(0);
      expect(root.querySelectorAll('article')).toHaveLength(allQuarantined ? 0 : 1);
      if (allQuarantined) {
        expect(root.textContent).toContain('表示できる論点はありません');
        expect(notices.textContent).toContain('非表示の論点2件');
      } else {
        expect(notices.textContent).toContain('元の論点2・注意: 文章が長い');
        expect(root.querySelector('h6')?.textContent).toBe(issue.title);
        expect(root.querySelector('[data-analysis-conclusion]')?.closest('details')).toBeNull();
        expect(root.querySelector('[data-analysis-reading]')?.textContent).toBe(issue.reading);
        const evidenceDetails = root.querySelector<HTMLDetailsElement>('[data-analysis-evidence]')!;
        expect(evidenceDetails.open).toBe(false);
        expect(evidenceDetails.textContent).toContain(issue.caveat);
        expect(evidenceDetails.textContent).toContain(issue.nextCheck);
        evidenceDetails.open = true;
        expect(evidenceDetails.textContent).toContain('確認済み事実');
        expect(root.textContent).toContain(issue.conclusion);
        expect(root.querySelector('article ul')?.textContent).toContain(
          '確認済み事実: 売上100億円'
        );
        expect(root.querySelector('a')?.getAttribute('href')).toBe(
          'https://www.release.tdnet.info/inbs/fixture.pdf#page=2'
        );
        expect(root.querySelector('a')?.getAttribute('rel')).toContain('noopener');
        expect(render('javascript:alert(1)').querySelector('a')).toBeNull();
      }
    }
  );
});
