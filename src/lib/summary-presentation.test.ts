import { describe, expect, it } from 'vitest';
import expectation from './fixtures/summary-content-expectations.json';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { parseFactSummary, renderFacts } from './fact-summary';
import {
  buildPresentation,
  revalidatePresentation,
  validatePresentation,
} from './summary-presentation';
import { sourceInventory } from './summary-source-inventory';
import { buildSummaryHtml } from '../content/utils/summaryHtmlBuilder';
import { summaryResultId } from './summary-result-id';

const page = textPage(expectation.text);
const facts = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'earnings',
    facts: [numberCandidate(page, '売上高', 1000), { ...numberCandidate(page), id: 'f2' }],
    unverified: [],
  }),
  'earnings',
  [page],
  false
);
const presentation = buildPresentation(facts, [page]);

describe('冒頭と本文の保持・復元・原文参照', () => {
  it('説明の内訳・混在した状態・未分類の施策を原文のまま保持する', () => {
    expect(sourceInventory([page]).map((e) => e.text)).toEqual(expectation.retained);
    expect(revalidatePresentation(presentation, facts, [page])).toEqual(presentation);
    const body = renderFacts(facts, presentation).split('## 2026')[1];
    expect(body).toContain('価格改定も行いました。');
    expect(body).toContain('承認を条件に実施する予定です。');
    expect(body).toContain('詳細は未定です。');
    // Literal source quotations do not become verified semantic facts used for scoring.
    expect(facts.facts).toHaveLength(2);
  });
  it('冒頭の選択を減らしても本文の全事実と引用は変わらない', () => {
    const brief = { ...presentation, overview: [facts.facts[0].id] };
    const body = (text: string) => text.slice(text.indexOf('\n\n##'));
    expect(body(renderFacts(facts, brief))).toBe(body(renderFacts(facts, presentation)));
    expect(brief.sections.flatMap((s) => s.factIds)).toEqual(facts.facts.map((f) => f.id));
  });
  it('補足の分断された文をつなぎ、段落とページ境界を保って引用枠を出さない', () => {
    const first = textPage(
      expectation.text + '\n共同開発は承認を条件に\n実施する予定です。\n開始時期は未定です。'
    );
    const second = textPage('３．その他の施策\n翌年度への影響は\n現時点では未定です。', 2);
    const display = buildPresentation(facts, [first, second]);
    const summary = renderFacts(facts, display);
    const supplement = summary.slice(summary.indexOf('## ３'));
    expect(supplement).toContain('共同開発は承認を条件に 実施する予定です。');
    expect(supplement).toContain('実施する予定です。\n\n開始時期は未定です。');
    expect(supplement).toContain('翌年度への影響は 現時点では未定です。');
    expect(supplement.match(/\(tdnet-page:1\)/g)).toHaveLength(1);
    expect(supplement.match(/\(tdnet-page:2\)/g)).toHaveLength(1);
    const html = buildSummaryHtml(summary, null, {
      companyName: 'テスト',
      title: '開示',
      pdfUrl: 'https://www.release.tdnet.info/inbs/test.pdf',
    });
    expect(html).not.toContain('<blockquote');
    expect(html).toContain('test.pdf#page=2');
    const sourceToggles = html.match(
      /<details class="tdnet-digest-source"[^>]*>[\s\S]*?<\/details>/g
    )!;
    expect(sourceToggles.length).toBeGreaterThan(0);
    expect(sourceToggles.every((toggle) => !/^<details[^>]*\bopen\b/.test(toggle))).toBe(true);
    expect(
      sourceToggles.every((toggle) => !toggle.includes('<h2') && !toggle.includes('<table'))
    ).toBe(true);
    const lastToggle = sourceToggles[sourceToggles.length - 1];
    expect(lastToggle).toContain('共同開発は承認を条件に 実施する予定です。');
    expect(lastToggle).toContain('翌年度への影響は 現時点では未定です。');
    expect(html.slice(0, html.indexOf('class="tdnet-digest-source"'))).toContain('全体要約');
    expect(display.excerpts.map((e) => e.text)).toEqual([
      ...expectation.retained,
      '共同開発は承認を条件に',
      '実施する予定です。',
      '開始時期は未定です。',
      '３．その他の施策',
      '翌年度への影響は',
      '現時点では未定です。',
    ]);
  });
  it('本文欠落・引用変更・未知項目・PDFとの相違を拒否する', () => {
    const missing = structuredClone(presentation);
    missing.sections[0].factIds.pop();
    expect(() => validatePresentation(missing, facts)).toThrow('欠落');
    const changed = structuredClone(presentation);
    changed.excerpts[0].text = '変更された引用';
    expect(() => validatePresentation(changed, facts)).toThrow('欠落・変更');
    expect(() => validatePresentation({ ...presentation, unknown: true }, facts)).toThrow('不正');
    expect(() =>
      revalidatePresentation(presentation, facts, [
        textPage(expectation.text.replace('価格改定', '価格据置')),
      ])
    ).toThrow('PDF');
  });
  it('予定日と本文を含む会社名の段落を管理情報として捨てない', () => {
    const source = textPage(
      '会社名 株式会社テスト\n１．実施時期\n2026年10月15日\n会社名は変更します。承認が条件です。\n会社名変更の理由\n会社名 株式会社対象 | 条件 承認後'
    );
    expect(sourceInventory([source]).map((e) => e.text)).toEqual([
      '１．実施時期',
      '2026年10月15日',
      '会社名は変更します。承認が条件です。',
      '会社名変更の理由',
      '会社名 株式会社対象 | 条件 承認後',
    ]);
  });
  it('MarkdownやHTMLを原文として表示し、安全な物理ページリンクを作る', () => {
    const source = textPage(
      expectation.text +
        '\n説明は[参照](javascript:alert(1)) | <img src=x onerror=alert(1)>です。https://x.com/uluru_ir - 注記。'
    );
    const html = buildSummaryHtml(renderFacts(facts, buildPresentation(facts, [source])), null, {
      companyName: 'テスト',
      title: '開示',
      pdfUrl: 'https://www.release.tdnet.info/inbs/140120260930543649.pdf',
    });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;img');
    expect(html).toContain('https://x.com/uluru_ir - 注記。');
    expect(html).toContain('140120260930543649.pdf#page=1');
    expect(html).not.toContain('tdnet-page:');
  });
  it('本文・引用を変更すると保存結果IDも変わる', async () => {
    const base = await summaryResultId(
      '140120260930543649.pdf',
      'v79:fixture:fixture:full',
      facts,
      'a'.repeat(64),
      presentation
    );
    const different = buildPresentation(facts, [
      textPage(expectation.text + '\n補足の条件があります。'),
    ]);
    expect(
      await summaryResultId(
        '140120260930543649.pdf',
        'v79:fixture:fixture:full',
        facts,
        'a'.repeat(64),
        different
      )
    ).not.toBe(base);
  });
});
