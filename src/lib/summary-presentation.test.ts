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
import corpus from './fixtures/ir-semantic-corpus.json';
import candidates from './fixtures/ir-semantic-expectations.json';
import { extractPageLayout } from './pdf-layout';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { VerifiedFact } from './fact-contract';
import { candidateResponse } from './fixtures/candidate-test-source';
import { reviewCandidates } from './fact-candidates';
import { summaryComparison, comparisonLabel } from './summary-comparison';

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
  it('目次・定型注意書き・記載省略・該当なしを冒頭の理由や条件にせず全文は保持する', () => {
    const notice =
      '本資料に記載されている業績見通し等の将来に関する記述は、当社が現在入手している情報及び合理的であると判断する一定の前提に基づいており、その達成を当社として約束する趣旨のものではありません。また、実際の業績等は様々な要因により大きく異なる可能性があります。';
    const toc =
      '１．経営成績等の概況……………………２\n（１）当中間期の経営成績の概況……………………２\n２．財務諸表……………………４';
    const routine =
      '（セグメント情報等の注記）【セグメント情報】前中間連結会計期間(自2025年３月１日至2025年８月31日)\n当社グループの報告セグメントはレストラン事業のみであり、他の事業セグメントの重要性が乏しいため、記載を省略しております。';
    const absence = '（株主資本の金額に著しい変動があった場合の注記）該当事項はありません。';
    const risk = '新規事業は承認を条件に実施する予定です。';
    const source = textPage(
      expectation.text +
        '\n' +
        notice +
        '\n○添付資料の目次\n' +
        toc +
        '\n４．セグメント情報等の注記\n' +
        routine +
        '\n' +
        absence +
        '\n５．取引条件\n' +
        risk
    );
    const display = buildPresentation(facts, [source]);
    const html = buildSummaryHtml(renderFacts(facts, display), null, {
      companyName: 'テスト',
      title: '決算',
      pdfUrl: 'https://www.release.tdnet.info/inbs/test.pdf',
    });
    const reading = html.replace(/<details\b[\s\S]*?<\/details>/g, '');
    for (const text of [notice, routine, absence].flatMap((text) => text.split('\n')))
      expect(reading).not.toContain(text);
    expect(reading).not.toContain('……………………');
    expect(reading).toContain(risk);
    for (const text of [notice, routine, absence].flatMap((text) => text.split('\n')))
      expect(html).toContain(text);
    expect(
      display.excerpts
        .filter((e) => e.text.includes('……………………') || e.text === notice)
        .every((e) => e.role === 'document')
    ).toBe(true);
  });
  it('比較条件が一致する確定値から増減・赤字変化を示し、異なる条件や範囲値は比較しない', () => {
    const current = facts.facts.find((f) => f.label === '営業利益')!;
    const previous = {
      ...current,
      id: 'previous',
      period: '2025年3月期',
      value: 120,
      quantity: { ...current.quantity!, decimal: '120' },
    } as VerifiedFact;
    const comparison = summaryComparison(current, [current, previous])!;
    expect(comparisonLabel(current, comparison)).toBe('↓減益');
    const loss = {
      ...current,
      quantity: { ...current.quantity!, decimal: '-100' },
    } as VerifiedFact;
    const oldLoss = {
      ...previous,
      quantity: { ...previous.quantity!, decimal: '-120' },
    } as VerifiedFact;
    expect(comparisonLabel(loss, summaryComparison(loss, [loss, oldLoss])!)).toBe('↑赤字縮小');
    const lossAmount = { ...current, label: '営業損失' };
    const previousLossAmount = { ...previous, label: '営業損失' };
    expect(
      comparisonLabel(lossAmount, summaryComparison(lossAmount, [lossAmount, previousLossAmount])!)
    ).toBe('↑損失縮小');
    expect(
      summaryComparison(current, [
        current,
        { ...previous, semantics: { ...previous.semantics, scope: '非連結' } },
      ])
    ).toBeNull();
    expect(
      summaryComparison(
        {
          ...current,
          kind: 'range',
          quantity: { raw: '100～150', decimal: null, lower: '100', upper: '150', sourceIds: [] },
        },
        [previous]
      )
    ).toBeNull();
  });
  it('修正前後の数値と上方・下方・据え置きを冒頭に表示する', () => {
    const id = 'revision-20260910';
    const pages = corpus
      .find((c) => c.id === id)!
      .pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
    const native = reviewCandidates(
      candidateResponse(
        candidates.find((c) => c.id === id)!.facts as unknown as VerifiedFact[],
        pages,
        'earningsRevision'
      ),
      'earningsRevision',
      pages
    ).facts;
    const summary = { ...facts, documentType: 'earningsRevision' as const, facts: native };
    const overview = renderFacts(summary, buildPresentation(summary, pages)).split(
      '## 修正内容'
    )[0]!;
    expect(overview).toContain('**↑上方修正** 2,800百万円 → 2,900百万円');
    expect(overview).toContain('親会社の所有者に帰属する当期利益');
    const after = native.find(
      (f) => f.label === '営業利益' && f.semantics.state === 'forecastAfter'
    )!;
    const same = { ...after, quantity: { ...after.quantity!, decimal: '2800' } } as VerifiedFact;
    const lower = { ...after, quantity: { ...after.quantity!, decimal: '2700' } } as VerifiedFact;
    expect(
      comparisonLabel(
        same,
        summaryComparison(same, [...native.filter((f) => f.id !== after.id), same])!
      )
    ).toBe('→据え置き');
    expect(
      comparisonLabel(
        lower,
        summaryComparison(lower, [...native.filter((f) => f.id !== after.id), lower])!
      )
    ).toBe('↓下方修正');
  });
  it('一般的な前置きと結果の重複を外し、原因・季節性を抜粋して条件と全文を保持する', () => {
    const introduction = 'わが国経済は物価上昇が続いています。一方、個人消費も低迷しています。';
    const reason =
      '以上の結果、当期の業績は、需要の減少と節約志向の強まりから利用の出し控えが見られたことなどにより、売上高は1,000百万円と前年同期に比べ100百万円（10.0%）の減収となりました。';
    const season =
      'なお、当社の属する業界は、通常の場合、春に需要期を迎えます。したがって、当社の売上高は３月から５月に偏る傾向があり、業績に季節的変動があります。';
    const qualified =
      '取引先との契約により売上高は増加しました。ただし、承認を条件としており、実施時期は未定です。';
    const operation =
      '設備投資は、昨年の事業譲受による拠点取得を踏まえ、業務効率化を目的として、４月より新工場の稼働を開始しました。加えて、新規出店３店舗と既存店のリニューアル14店舗を実施しました。';
    const source = textPage(
      expectation.text +
        '\n１．増減要因\n' +
        [introduction, reason, season, qualified, operation].join('\n')
    );
    const display = buildPresentation(facts, [source]);
    const html = buildSummaryHtml(renderFacts(facts, display), null, {
      companyName: 'テスト',
      title: '決算',
      pdfUrl: 'https://www.release.tdnet.info/inbs/test.pdf',
    });
    const reading = html.replace(/<details\b[\s\S]*?<\/details>/g, '');
    expect(reading).toContain('需要の減少と節約志向の強まりから利用の出し控えが見られた');
    expect(reading).toContain('売上高…前年同期に比べ…（10.0%）の減収');
    expect(reading).toContain(
      '当社の売上高は３月から５月に偏る傾向があり、業績に季節的変動があります。'
    );
    expect(reading).toContain(qualified);
    expect(reading).toContain('設備投資は、…４月より新工場の稼働を開始しました。');
    expect(reading).toContain('新規出店３店舗と既存店のリニューアル14店舗');
    expect(reading).not.toContain(introduction);
    expect(reading).not.toContain('売上高は1,000百万円と前年同期に比べ100百万円');
    expect(reading).not.toContain('通常の場合、春に需要期を迎えます。');
    for (const original of [introduction, reason, season, qualified, operation])
      expect(html).toContain(original);
    expect(display.excerpts.map((e) => e.text)).toEqual(
      sourceInventory([source], undefined, 'earnings').map((e) => e.text)
    );
  });
  it('出来事に別段落から適用される条件を通常表示の同じ項目に残す', () => {
    const id = 'revision-20260910';
    const pages = corpus
      .find((entry) => entry.id === id)!
      .pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));
    const response = candidateResponse(
      candidates.find((entry) => entry.id === id)!.facts as unknown as VerifiedFact[],
      pages,
      'earningsRevision'
    );
    const event = reviewCandidates(response, 'earningsRevision', pages).facts.find(
      (f) => f.kind === 'event' && f.statement?.includes('１株につき127円')
    )!;
    const summary = { ...facts, documentType: 'earningsRevision' as const, facts: [event] };
    const html = buildSummaryHtml(renderFacts(summary, buildPresentation(summary, pages)), null, {
      companyName: 'GMOフィナンシャルゲート',
      title: '配当予想の修正',
      pdfUrl: 'https://www.release.tdnet.info/inbs/test.pdf',
    });
    const body = html.slice(html.indexOf('>配当</h2>'));
    const item = body.match(/<li[^>]*>2026年９月期の配当予想[^<]*<\/li>/)![0];
    expect(item.replace(/\s/g, '')).toContain('様々な要因により大きく異なる可能性があります。');
  });
  it('説明の内訳・混在した状態・未分類の施策を原文のまま保持する', () => {
    expect(sourceInventory([page]).map((e) => e.text)).toEqual(expectation.retained);
    expect(revalidatePresentation(presentation, facts, [page])).toEqual(presentation);
    const body = renderFacts(facts, presentation).split('## 業績と増減要因')[1];
    expect(body).toContain('価格改定も行いました。');
    expect(body).toContain('承認を条件に実施する予定です。');
    expect(body).toContain('詳細は未定です。');
    // Literal source quotations do not become verified semantic facts used for scoring.
    expect(facts.facts).toHaveLength(2);
  });
  it('冒頭の選択を減らしても本文の全事実と引用は変わらない', () => {
    const brief = { ...presentation, overview: [facts.facts[0].id] };
    const body = (text: string) => text.slice(text.indexOf('## 業績と増減要因'));
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
    const supplement = summary.slice(summary.indexOf('## 事業・施策'));
    expect(supplement).toContain('共同開発は承認を条件に 実施する予定です。');
    expect(supplement).toContain('実施する予定です。\n\n開始時期は未定です。');
    expect(supplement).toContain('翌年度への影響は 現時点では未定です。');
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
    const lastToggle = sourceToggles.find((toggle) => toggle.includes('共同開発'))!;
    expect(lastToggle).toContain('共同開発は承認を条件に 実施する予定です。');
    expect(lastToggle).toContain('翌年度への影響は 現時点では未定です。');
    expect(lastToggle).toContain('原文を見る（p.1、p.2）');
    expect(html.slice(0, html.indexOf('class="tdnet-digest-source"'))).toContain('開示の要点');
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
    expect(() => validatePresentation({ ...presentation, version: 1 }, facts)).toThrow('不正');
    expect(() =>
      validatePresentation(
        {
          ...presentation,
          overview: [presentation.excerpts.find((e) => e.kind === 'heading')!.id],
        },
        facts
      )
    ).toThrow('冒頭');
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
