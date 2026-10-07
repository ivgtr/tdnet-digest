import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPdfPageLayout } from '../../src/lib/pdf-layout';
import { reviewCandidates } from '../../src/lib/fact-candidates';
import { sourceTableId } from '../../src/lib/source-provenance';
import { buildPresentation, revalidatePresentation } from '../../src/lib/summary-presentation';
import { organizationHash } from '../../src/lib/summary-organization';
import { checkObservation } from '../../src/lib/disclosure-observation';
import { fixedOrganization } from '../../src/lib/fixtures/summary-narrative-source';
import { buildAnalysisInput } from '../../src/lib/analysis-input';
import { parseAnalysisResponse, parseAnalysis } from '../../src/lib/additional-analysis';
import { buildAnalysisStageHtml } from '../../src/content/utils/summaryHtmlBuilder';
import type { ExtractedPage } from '../../src/types/summaryMetadata';
// Fixed, human-selected source and responses: this checks the source/analysis/UI
// contract without an API call. It does not measure live model selection quality.
const pdfPath = process.argv[2];
if (!pdfPath) throw new Error('Pass the downloaded 140120261005546285.pdf path');
const bytes = readFileSync(pdfPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
assert.equal(sha256, '56aedf42833a81c078dcd4ed57c15b5a0cee3430fbbdc1e8c4ff59d6f2b53c73');
const pdf = await getDocument({
  data: new Uint8Array(bytes),
  cMapUrl: resolve('dist/cmaps') + '/',
  cMapPacked: true,
  useWorkerFetch: false,
  isEvalSupported: false,
  useSystemFonts: true,
}).promise;
const pages: ExtractedPage[] = [];
for (let page = 1; page <= pdf.numPages; page++)
  pages.push(await extractPdfPageLayout(await pdf.getPage(page), page, OPS));
await pdf.destroy();
const candidates = [
  ['p1s47', 1, '2026年11月期第3四半期', 'cumulativeQ3', 'actual'],
  ['p1s151', 1, '2026年11月期', 'fullYear', 'forecast'],
].map(([valueId, page, period, periodKind, state], i) => ({
  candidateId: `c${i}`,
  importance: 'key',
  kind: 'number',
  source: {
    kind: 'table',
    valueId,
    tableId: sourceTableId(pages[Number(page) - 1], String(valueId)),
    contextBindingId: `ctx:${valueId}`,
  },
  meaning: {
    subject: '株式会社サーラコーポレーション',
    scope: '連結',
    basis: '日本基準',
    period,
    periodKind,
    metricKind: 'amount',
    state,
    polarity: 'affirmative',
  },
}));
const review = reviewCandidates(
  JSON.stringify({ candidateVersion: 4, documentType: 'earnings', candidates, unverified: [] }),
  'earnings',
  pages
);
assert.deepEqual(review.unverified, []);
assert.deepEqual(
  review.facts.map((f) => f.quantity?.decimal),
  ['8168', '7800']
);
const facts = {
  version: 6,
  documentType: 'earnings' as const,
  facts: review.facts,
  unverified: [],
};
const display = buildPresentation(facts, pages);
const summaries = [
  ['p5b4', '住宅販売では注文住宅の販売棟数が増加し、資材販売も伸びた。'],
  ['p5b7', '中古車の在庫処分の影響が解消され、中古車販売台数も増加して営業損失が縮小した。'],
  ['p5b13', '自社保有資産の売却と賃貸収入の伸長が営業利益の増加に寄与した。'],
  ['p6b11', '通期業績予想は据え置かれている。'],
].map(([blockId, text], i) => ({
  id: `sample-explanation-${i}`,
  text,
  sourceIds: [display.excerpts.find((e) => e.blockId === blockId)!.id],
}));
display.organization = fixedOrganization(facts, display, {
  version: 1,
  overview: [],
  sections: [
    {
      id: 'sample',
      title: '会社説明',
      sourceIds: summaries.flatMap((s) => s.sourceIds),
      summary: summaries,
    },
  ],
});
for (const [id, metric, valueId, previous] of [
  ['observation-0', '営業活動によるキャッシュ・フロー', 'p11s112', 'p11s111'],
  ['observation-1', '投資活動によるキャッシュ・フロー', 'p12s54', null],
]) {
  const value = display.values.find((v) => v.id === valueId)!;
  const observation = {
    id: id!,
    topic: 'cash' as const,
    entity: null,
    scope: '連結',
    basis: '日本基準',
    period: '2026年11月期第3四半期累計',
    state: 'actual' as const,
    conditions: [],
    sourceIds: value.sourceIds,
    metric: metric!,
    measure: 'flow' as const,
    valueId: valueId!,
    comparison: previous
      ? {
          axis: 'yearOnYear' as const,
          period: '2025年11月期第3四半期累計',
          state: 'actual' as const,
          valueId: previous,
          rateId: null,
        }
      : null,
  };
  observation.sourceIds = checkObservation(
    observation,
    display.values,
    display.excerpts,
    facts,
    true
  );
  display.organization.observations.push(observation);
  display.organization.review!.claims[id!] = null;
}
display.organization.review!.contentHash = organizationHash(
  display.organization,
  facts,
  display.values,
  display.excerpts
);
revalidatePresentation(display, facts, pages);
const input = buildAnalysisInput(facts, display);
assert.ok(
  input.evidence.some((e) => e.id.startsWith('calc:remaining:') && e.text.includes('-368百万円'))
);
assert.ok(
  input.evidence.some(
    (e) => e.id.startsWith('calc:cashFlowTotal:') && e.text.includes('-11155百万円')
  )
);
assert.ok(
  input.evidence.some((e) => e.id.startsWith('calc:difference:') && e.text.includes('-9743百万円'))
);
const refs = (test: (e: (typeof input.evidence)[number]) => boolean) =>
  input.evidence.filter(test).map((e) => e.id);
const response = {
  version: 3,
  issues: [
    {
      title: '通期計画を超えた累計利益',
      conclusion: '計画超過と予想据え置きの理由が次の焦点です',
      evidenceIds: refs(
        (e) => e.id.startsWith('calc:remaining:') || e.id === 'explanation:explanation-3'
      ),
      reading:
        '通期予想からの差し引きは残り期間への慎重さを示す可能性がありますが、費用や季節性の確認が必要です',
      caveat:
        '差し引き残額は会社が示した最終四半期の利益予想ではなく、上方修正も確実ではありません',
      nextCheck: '次の決算説明で予想据え置きの理由と残る費用・季節性を確認する',
    },
    {
      title: '増益要因の継続性は一様でない',
      conclusion: '住宅の伸びと反動・売却の寄与を分けて確認する必要があります',
      evidenceIds: [
        'explanation:explanation-0',
        'explanation:explanation-1',
        'explanation:explanation-2',
      ],
      reading:
        '販売増が続くかと、過去の在庫処分の反動や資産売却が繰り返されるかでは、翌期への含意が異なります',
      caveat: '今回の確認済み入力では各要因の利益寄与額と今後の継続性は未確認です',
      nextCheck: '住宅の受注と販売、カーライフの赤字継続、売却益を除いた利益を確認する',
    },
    {
      title: '利益と資金の動きに差',
      conclusion: '営業と投資の資金収支から資金手当ての確認が必要です',
      evidenceIds: refs(
        (e) =>
          e.id.startsWith('calc:cashFlowTotal:') ||
          (e.kind === 'observation' && e.text.includes('営業活動'))
      ),
      reading:
        '営業と投資の資金収支がマイナスなら、手元資金や財務活動への依存を確認する必要があります',
      caveat: '今回の確認済み入力だけでは資金不足や財務危機とは判断できません',
      nextCheck: '運転資金の増減が戻るか、投資の回収計画と資金調達条件を確認する',
    },
  ],
};
const analysis = parseAnalysisResponse(JSON.stringify(response), input);
parseAnalysis(JSON.stringify(analysis), facts, display);
const html = buildAnalysisStageHtml(
  { loading: false, data: analysis, error: null },
  facts.facts,
  'https://www.release.tdnet.info/inbs/140120261005546285.pdf'
);
mkdirSync('evaluation/results/local', { recursive: true });
writeFileSync(
  'evaluation/results/local/sala-analysis-check.json',
  JSON.stringify(
    {
      source: 'https://www.release.tdnet.info/inbs/140120261005546285.pdf',
      evidenceMode:
        'actual PDF extraction, fixed candidate/explanation/analysis responses; not a live model run',
      candidateRejections: review.unverified,
      input,
      analysis,
    },
    null,
    2
  )
);
writeFileSync(
  'evaluation/results/local/sala-analysis-check.html',
  `<!doctype html><meta charset="utf-8"><body>${html}</body>`
);
assert.equal(analysis.issues.length, 3);
assert.equal((html.match(/href=/g) ?? []).length, 5);
assert.deepEqual(analysis.coverage.pages, [1, 5, 6, 11, 12]);
console.log(
  'PASS',
  facts.facts.length,
  'facts',
  analysis.issues.length,
  'issues',
  input.coverage,
  'links',
  html.match(/href=/g)?.length
);
