import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageLayout } from '../../src/lib/pdf-layout';
import { numberCandidate } from '../../src/lib/fixtures/v4-test-source';
import {
  buildDocumentContext,
  bindingFor,
  resolveScopeIds,
  isFinancialUnit,
} from '../../src/lib/document-context';
import { assertionPolarity } from '../../src/lib/assertion-semantics';
import { candidateResponse } from '../../src/lib/fixtures/candidate-test-source';
import { reviewCandidates } from '../../src/lib/fact-candidates';
import { stableFactId, type VerifiedFact, type FactSummary } from '../../src/lib/fact-contract';
import { parseFactSummary, renderFacts } from '../../src/lib/fact-summary';
import type { DocumentType } from '../../src/lib/document-type';

/** Deterministic text PDF, not an offscreen mock: PDF.js must recover these physical pages. */
function textPdf(texts: string[], columns = [30, 280, 500]): Uint8Array {
  const hex = (text: string) =>
    [...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
  const objects: string[] = [
    '',
    '',
    '<< /Type /Font /Subtype /Type0 /BaseFont /ReviewFont /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ReviewFont /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 0 >> /DW 1000 /CIDToGIDMap /Identity /FontDescriptor 6 0 R >>',
  ];
  const codes = [...new Set(texts.join('').split(''))].map((c) => hex(c));
  const cmap = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /ReviewUnicode def /CMapType 2 def 1 begincodespacerange <0000> <ffff> endcodespacerange ${codes.length} beginbfchar ${codes.map((c) => `<${c}> <${c}>`).join(' ')} endbfchar endcmap CMapName currentdict /CMap defineresource pop end end`;
  const stream = (body: string) => `<< /Length ${body.length} >>\nstream\n${body}\nendstream`;
  objects.push(stream(cmap));
  objects.push(
    '<< /Type /FontDescriptor /FontName /ReviewFont /Flags 4 /FontBBox [0 -200 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -200 /CapHeight 700 /StemV 80 >>'
  );
  const kids: number[] = [];
  for (const text of texts) {
    const id = objects.length + 1;
    kids.push(id);
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1200 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`
    );
    objects.push(
      stream(
        text
          .split('\n')
          .flatMap((line, i) =>
            line
              .split('\t')
              .map(
                (cell, j) =>
                  `BT /F1 10 Tf 1 0 0 1 ${columns[j]} ${800 - i * 24 + (/^\(2\)/.test(line) ? 4 : 0)} Tm <${hex(cell)}> Tj ET`
              )
          )
          .join('\n')
      )
    );
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[1] = `<< /Type /Pages /Count ${kids.length} /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] >>`;
  let pdf = '%PDF-1.7\n';
  const offsets = [0];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${n.toString().padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
export async function additionalReviewFixture(mode: string) {
  if (mode === 'semantic-ownership') return periodOutlookUnitsFixture(true);
  if (mode === 'period-outlook-units') return periodOutlookUnitsFixture();
  if (mode === 'inherited-outlook-yen') return inheritedOutlookYenFixture();
  if (mode === 'prose-disclosures') return proseDisclosuresFixture();
  if (
    [
      'semantics',
      'event-semantics',
      'cover-outlook',
      'cover-boundary',
      'cover-signs',
      'cover-ifrs-company',
      'net-profit-passive',
      'passive-endings',
      'assertion-conflict',
      'metric-repair',
    ].includes(mode)
  )
    return latestReviewFixture(mode);
  if (!['reject', 'repair', 'attributes', 'boundary'].includes(mode))
    throw Error('未知の追加レビューケース');
  const period = '2027年3月期';
  const tails = [
    '100百万円ではなく200百万円を見込んでおります。',
    '100百万円に満たない見込みです。',
    '100百万円に届かない見込みです。',
    '100百万円（には満たない見込み）です。',
  ];
  const texts =
    mode === 'attributes'
      ? [
          `${period} 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト`,
          ...['財政状態', '経営成績', '業績予想'].map(
            (h) =>
              `1. ${period} ${h}\n範囲 個別\n会計基準 IFRS\n${period}の売上高は100百万円${h === '業績予想' ? 'の見込みです' : 'です'}。`
          ),
        ]
      : mode === 'boundary'
        ? [
            '会社名 株式会社テスト',
            `1. ${period} 業績予想\n${period}の売上高は100百万円の見込みです\n(2)取得条件は別途決定します`,
          ]
        : [
            `会社名 株式会社テスト`,
            ...tails.map((t) => `1. ${period} 業績予想\n${period}の売上高は${t}`),
          ];
  const pdf = textPdf(texts);
  const document = await getDocument({ data: pdf.slice(), disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n++) {
    const p = await document.getPage(n);
    pages.push(extractPageLayout((await p.getTextContent()).items, n));
    p.cleanup();
  }
  await document.destroy();
  const context = buildDocumentContext(pages);
  const facts = pages.slice(1).map((p, i) => {
    if (!p.text.includes('売上高'))
      throw Error(JSON.stringify({ page: p.pageNumber, text: p.text }));
    const f = numberCandidate(p, '売上高', 100, period);
    f.id = `f${i + 1}`;
    f.semantics.scope = mode === 'attributes' ? '個別' : null;
    f.semantics.basis = mode === 'attributes' ? 'IFRS' : null;
    f.valueKind = f.semantics.state = mode !== 'attributes' || i === 2 ? 'forecast' : 'actual';
    f.semantics.polarity = assertionPolarity(f.quote);
    const b = bindingFor(context, f.evidence.kind === 'prose' ? f.evidence.blockId : '');
    f.evidence.contextIds = b.contextIds;
    f.evidence.scopeIds = resolveScopeIds(b, f.semantics, true);
    return f;
  });
  const events = facts.map((f) => ({
    ...f,
    kind: 'event' as const,
    label: f.quote,
    statement: f.quote,
    value: null,
    unit: null,
    valueKind: null,
    semantics: { ...f.semantics, metricKind: 'none' as const },
  }));
  const legacyFacts = facts.map((f) => {
    const old = structuredClone(f);
    const page = pages.find((p) => p.pageNumber === old.page)!;
    if (old.evidence.kind !== 'prose') throw Error('expected prose');
    const block = page.blocks.find((b) => b.id === old.evidence.blockId)!;
    old.quantity = {
      raw: '100',
      decimal: '100',
      sourceIds: block.spanIds.flatMap((id) => page.spans.find((s) => s.id === id)!.sourceIds!),
    };
    old.dateRoles = [];
    old.semantics.polarity = 'affirmative';
    old.id = stableFactId(old);
    return old;
  });
  const legacy: FactSummary = {
    version: 4,
    documentType: 'other',
    facts: legacyFacts,
    unverified: [],
  };
  const first = JSON.parse(candidateResponse(facts, pages));
  const warnings = mode === 'repair' ? ['補足内訳は確認できません'] : [];
  first.unverified = warnings;
  if (mode === 'boundary' && !facts[0].quote.includes('\n(2)'))
    throw Error('番号付き欄が実PDF抽出で結合していません');
  return {
    pdf,
    pages,
    first: JSON.stringify(first),
    repair: candidateResponse(mode === 'repair' ? events : facts, pages),
    legacy,
    legacyRendered: renderFacts(legacy),
    expected:
      mode === 'attributes'
        ? ['個別', 'IFRS', '実績', '予想']
        : mode === 'boundary'
          ? ['売上高: 100百万円', '予想']
          : [...tails, ...warnings],
    warnings,
    documentType: 'other' as DocumentType,
    repairRequired: mode === 'repair',
  };
}

async function latestReviewFixture(mode: string) {
  const report = [
    'cover-outlook',
    'cover-boundary',
    'cover-signs',
    'cover-ifrs-company',
    'net-profit-passive',
    'passive-endings',
    'assertion-conflict',
  ].includes(mode);
  const period = '2027年3月期';
  const documentType: DocumentType = report ? 'earnings' : 'other';
  const metrics =
    mode === 'cover-ifrs-company'
      ? ['売上高', '営業利益', '親会社の所有者に帰属する四半期利益']
      : mode === 'cover-signs'
        ? ['売上高', '営業損失', '当期純損失']
        : ['売上高', '営業利益', '当期純利益'];
  const bodies =
    mode === 'event-semantics'
      ? [
          '当社の売上高は100百万円とは見込まれません。',
          '当社はAの取得を行いますがBの取得は行いません。',
          '当社は来期に新工場を建設することとなりました。',
        ]
      : ['当社は自己株式の取得を行いません。', '当社はAの取得を行いませんが別案件を取得しました。'];
  const texts = report
    ? [
        `${period} 決算短信〔${mode === 'cover-ifrs-company' ? 'IFRS' : '日本基準'}〕（連結）\n${mode === 'cover-ifrs-company' ? '上場会社名：株式会社テスト' : '会社名 株式会社テスト'}\n${metrics.map((m) => `${period}の${m}は${mode === 'cover-signs' ? (m === '営業損失' ? '▲10' : m === '当期純損失' ? '−20' : '100') : '100'}百万円です。`).join('\n')}${mode === 'net-profit-passive' ? `\n${period}の利益は5百万円です。` : ''}\n${period}の通期業績予想について説明します。${mode === 'cover-boundary' ? `\n事業概況\n${period}の売上高は200百万円です。` : ''}`,
        `1. 今後の見通し\n範囲 個別\n会計基準 IFRS\n${metrics.map((m, i) => `${period}の${m}は100百万円${mode === 'passive-endings' ? ['と見込まれる', 'と見込まれております', 'と見込まれています'][i] : mode === 'net-profit-passive' ? 'と見込まれます' : 'の見込みです'}。`).join('\n')}`,
      ]
    : mode === 'semantics' || mode === 'event-semantics'
      ? ['会社名 株式会社テスト', ...bodies.map((body) => `1. 事業説明\n${body}`)]
      : [
          '会社名 株式会社テスト',
          `1. ${period} 業績予想\n${period}の売上高は100百万円の見込みです。`,
        ];
  if (mode === 'assertion-conflict') texts.push('1. 事業説明\n当社は2027年3月1日に決議しました。');
  const pdf = textPdf(texts);
  const document = await getDocument({ data: pdf.slice(), disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n++) {
    const p = await document.getPage(n);
    pages.push(extractPageLayout((await p.getTextContent()).items, n));
    p.cleanup();
  }
  await document.destroy();
  const context = buildDocumentContext(pages);
  const facts: VerifiedFact[] = [];
  for (const page of report ? pages : pages.slice(1)) {
    const assertionMode =
      mode === 'semantics' ||
      mode === 'event-semantics' ||
      (mode === 'assertion-conflict' && page.pageNumber === 3);
    for (const metric of assertionMode ? ['当社'] : report ? metrics : ['売上高']) {
      const value =
        mode === 'cover-signs' && page.pageNumber === 1
          ? metric === '営業損失'
            ? -10
            : metric === '当期純損失'
              ? -20
              : 100
          : 100;
      const f = numberCandidate(page, metric, value, period);
      f.semantics.scope = report ? (page.pageNumber === 1 ? '連結' : '個別') : null;
      f.semantics.basis = report
        ? page.pageNumber === 1 && mode !== 'cover-ifrs-company'
          ? '日本基準'
          : 'IFRS'
        : null;
      if (assertionMode) {
        f.semantics.scope = f.semantics.basis = null;
        f.kind = 'event';
        f.label = f.statement = f.quote;
        f.value = f.unit = f.valueKind = null;
        f.period = null;
        f.semantics.periodKind = 'none';
        f.semantics.metricKind = 'none';
        f.semantics.state =
          mode === 'event-semantics'
            ? page.pageNumber === 2
              ? 'forecast'
              : 'unspecified'
            : mode === 'assertion-conflict'
              ? 'decided'
              : page.pageNumber === 2
                ? 'unspecified'
                : 'completed';
        f.semantics.polarity =
          mode === 'event-semantics'
            ? page.pageNumber === 2
              ? 'negative'
              : page.pageNumber === 3
                ? 'mixed'
                : 'affirmative'
            : mode === 'assertion-conflict'
              ? 'affirmative'
              : page.pageNumber === 2
                ? 'negative'
                : 'mixed';
      } else
        f.valueKind = f.semantics.state = report && page.pageNumber === 1 ? 'actual' : 'forecast';
      const binding = bindingFor(context, f.evidence.kind === 'prose' ? f.evidence.blockId : '');
      f.evidence.contextIds = binding.contextIds;
      f.evidence.scopeIds = resolveScopeIds(binding, f.semantics, report && !assertionMode);
      f.id = `f${facts.length + 1}`;
      facts.push(f);
    }
  }
  const checked = parseFactSummary(
    JSON.stringify({ version: 4, documentType, facts, unverified: [] }),
    documentType,
    pages
  );
  if (checked.facts.length !== facts.length || checked.unverified.length)
    throw Error(JSON.stringify(checked.unverified));
  const wrong = structuredClone(facts);
  if (mode === 'event-semantics') {
    wrong[0].semantics.polarity = 'affirmative';
    wrong[1].semantics.polarity = 'negative';
    wrong[2].semantics.state = 'actual';
  } else if (mode === 'semantics') {
    wrong[0].semantics.state = 'unspecified';
    wrong[0].semantics.polarity = 'affirmative';
    wrong[1].semantics.polarity = 'negative';
  } else if (mode === 'cover-ifrs-company') {
    wrong[0].semantics.subject = ':株式会社テスト';
    wrong[2].semantics.basis = null;
  } else if (report)
    wrong.slice(0, 3).forEach((f) => {
      f.semantics.scope = f.semantics.basis = null;
    });
  else wrong[0].semantics.scope = '連結';
  let initial = wrong;
  let repairFacts = report ? facts.slice(0, 3) : facts;
  let ambiguous: VerifiedFact | undefined;
  if (mode === 'net-profit-passive') {
    const draft = numberCandidate(pages[0], '利益', 5, period);
    if (draft.evidence.kind !== 'prose') throw Error('expected prose');
    const block = pages[0].blocks.find((b) => b.text === `${period}の利益は5百万円です。`)!;
    draft.evidence.blockId = block.id;
    draft.quote = block.text;
    draft.semantics.scope = draft.semantics.basis = null;
    draft.evidence.contextIds = bindingFor(context, block.id).contextIds;
    ambiguous = reviewCandidates(candidateResponse([draft], pages), 'other', pages).facts[0];
    if (!ambiguous) throw Error('generic profit did not validate');
    ambiguous.semantics.scope = '連結';
    ambiguous.semantics.basis = '日本基準';
    ambiguous.evidence.scopeIds = resolveScopeIds(
      bindingFor(context, block.id),
      ambiguous.semantics,
      true
    );
    ambiguous.id = stableFactId(ambiguous);
    initial = [...facts.slice(0, 2), ambiguous, ...facts.slice(3)];
  }
  if (mode === 'passive-endings') {
    initial = structuredClone(facts);
    initial[3].valueKind = initial[3].semantics.state = 'actual';
    repairFacts = [facts[3]];
  } else if (mode === 'assertion-conflict') {
    initial = facts.slice(1);
    const dated = structuredClone(facts[facts.length - 1]);
    dated.period = '2027年3月1日';
    dated.semantics.periodKind = 'eventDate';
    repairFacts = [facts[0], dated];
  } else if (mode === 'cover-boundary') {
    const late = numberCandidate(pages[0], '売上高', 200, period);
    const block = pages[0].blocks.find((b) => b.text.includes('売上高は200'))!;
    if (late.evidence.kind !== 'prose') throw Error('expected prose');
    late.evidence.blockId = block.id;
    late.evidence.contextIds = bindingFor(context, block.id).contextIds;
    late.quote = block.text;
    late.id = 'f7';
    initial = [...facts.slice(1), late];
    repairFacts = [facts[0]];
  }
  const first = JSON.parse(candidateResponse(initial, pages, documentType));
  const warnings =
    mode === 'cover-boundary' || mode === 'net-profit-passive'
      ? reviewCandidates(JSON.stringify(first), documentType, pages).unverified
      : [];
  if (mode === 'metric-repair') first.candidates[0].source.metric = '売上 高';
  const legacy = structuredClone(checked);
  if (mode === 'net-profit-passive') {
    legacy.facts[2] = ambiguous!;
  } else if (mode === 'assertion-conflict') {
    const dated = structuredClone(checked.facts[checked.facts.length - 1]);
    dated.period = '2027年3月1日';
    dated.semantics.periodKind = 'eventDate';
    dated.id = stableFactId(dated);
    legacy.facts.push(dated);
  } else if (mode === 'cover-boundary') {
    const late = structuredClone(initial[initial.length - 1]);
    late.semantics.scope = late.semantics.basis = null;
    late.evidence.scopeIds = resolveScopeIds(
      bindingFor(context, late.evidence.kind === 'prose' ? late.evidence.blockId : ''),
      late.semantics,
      false
    );
    const validLate = parseFactSummary(
      JSON.stringify({ version: 4, documentType: 'other', facts: [late], unverified: [] }),
      'other',
      pages
    ).facts[0];
    if (!validLate) throw Error('business source did not validate');
    validLate.semantics.scope = '連結';
    validLate.semantics.basis = '日本基準';
    validLate.evidence.scopeIds = resolveScopeIds(
      bindingFor(context, late.evidence.kind === 'prose' ? late.evidence.blockId : ''),
      validLate.semantics,
      true
    );
    validLate.id = stableFactId(validLate);
    legacy.facts = [...checked.facts.slice(1), validLate];
  } else if (mode === 'cover-ifrs-company') {
    legacy.facts[0].semantics.subject = ':株式会社テスト';
    legacy.facts[0].id = stableFactId(legacy.facts[0]);
  } else if (mode === 'passive-endings') {
    legacy.unverified = ['旧v45の診断'];
  } else if (mode === 'semantics' || mode === 'event-semantics')
    legacy.facts.forEach((f, i) => {
      f.semantics = wrong[i].semantics;
      f.id = stableFactId(f);
    });
  else if (report)
    legacy.facts.slice(0, 3).forEach((f) => {
      f.semantics.scope = f.semantics.basis = null;
      if (f.evidence.kind !== 'prose') throw Error('expected prose');
      f.evidence.scopeIds = resolveScopeIds(
        bindingFor(context, f.evidence.blockId),
        f.semantics,
        false
      );
      f.id = stableFactId(f);
    });
  else legacy.unverified = ['c1 SCOPE:修復済みの旧診断'];
  return {
    pdf,
    pages,
    documentType,
    repairRequired: true,
    first: JSON.stringify(first),
    repair: candidateResponse(repairFacts, pages, documentType),
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings,
    expected:
      mode === 'semantics' || mode === 'event-semantics'
        ? bodies
        : report
          ? mode === 'cover-ifrs-company'
            ? [
                '株式会社テスト',
                '連結',
                '個別',
                'IFRS',
                '親会社の所有者に帰属する四半期利益: 100百万円',
              ]
            : ['連結', '日本基準', '個別', 'IFRS', '売上高: 100百万円']
          : ['売上高: 100百万円'],
  };
}

async function proseDisclosuresFixture() {
  const period = '2027年3月期';
  const metrics = ['売上高', '営業利益', '当期純利益'];
  const body = '親会社株主に帰属する当期純損失は概算額100百万円となる見通しです。';
  const pdf = textPdf([
    `${period} 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${metrics.map((m) => `${period}の${m}は 100 百万円です。`).join('\n')}\n${period}の売上高営業利益率は 10 %です。`,
    `1. 損失予想の背景\n範囲 個別\n会計基準 IFRS\n${body}`,
  ]);
  const document = await getDocument({ data: pdf.slice(), disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n++) {
    const p = await document.getPage(n);
    pages.push(extractPageLayout((await p.getTextContent()).items, n));
    p.cleanup();
  }
  await document.destroy();
  const facts = metrics.map((m) => numberCandidate(pages[0], m, 100, period));
  const margin = numberCandidate(pages[0], '売上高営業利益率', 10, period);
  margin.unit = '%';
  margin.semantics.metricKind = 'rate';
  const background = numberCandidate(pages[1], '純損失', 100, period);
  background.kind = 'event';
  background.label = background.statement = background.quote;
  background.value = background.unit = background.valueKind = background.period = null;
  background.semantics.periodKind = 'none';
  background.semantics.metricKind = 'none';
  background.semantics.scope = '個別';
  background.semantics.basis = 'IFRS';
  background.semantics.state = 'forecast';
  background.semantics.qualifiers = ['概算額'];
  facts.push(margin, background);
  const context = buildDocumentContext(pages);
  facts.forEach((f, i) => {
    const binding = bindingFor(context, f.evidence.kind === 'prose' ? f.evidence.blockId : '');
    f.id = `f${i + 1}`;
    f.evidence.contextIds = binding.contextIds;
    f.evidence.qualifierIds = binding.qualifierIds;
    f.evidence.scopeIds = resolveScopeIds(binding, f.semantics, true);
  });
  const checked = parseFactSummary(
    JSON.stringify({ version: 4, documentType: 'earnings', facts, unverified: [] }),
    'earnings',
    pages
  );
  if (checked.unverified.length || checked.facts.length !== 5)
    throw Error(JSON.stringify(checked.unverified));
  const wrong = structuredClone(facts);
  wrong[3].semantics.metricKind = 'amount';
  wrong[4].semantics.state = 'unspecified';
  const first = candidateResponse(wrong, pages, 'earnings');
  const initial = reviewCandidates(first, 'earnings', pages);
  if (initial.facts.length !== 3) throw Error('initial wrong meaning was not rejected');
  const legacy = structuredClone(checked);
  legacy.facts[4].semantics.state = 'unspecified';
  legacy.facts[4].id = stableFactId(legacy.facts[4]);
  return {
    pdf,
    pages,
    documentType: 'earnings' as DocumentType,
    repairRequired: true,
    first,
    repair: candidateResponse(facts.slice(3), pages, 'earnings'),
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [],
    expected: ['売上高: 100百万円', '売上高営業利益率: 10%', body, '個別', 'IFRS'],
  };
}

async function inheritedOutlookYenFixture() {
  const period = '2027年3月期';
  const historical = '2026年3月期';
  const metrics = ['売上高', '営業利益', '当期純利益'];
  const body = '親会社株主に帰属する当期純損失は概算額100万円となる見通しではありません。';
  const pdf = textPdf([
    `${period} 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${metrics.map((m) => `${period}の${m}は100万円です。`).join('\n')}`,
    `1. ${historical} 経営成績\n範囲 個別\n会計基準 IFRS\n売上高営業利益率は10%です。`,
    `2. 損失予想の背景\n範囲 個別\n会計基準 IFRS\n${body}`,
  ]);
  const document = await getDocument({ data: pdf.slice(), disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n++) {
    const p = await document.getPage(n);
    pages.push(extractPageLayout((await p.getTextContent()).items, n));
    p.cleanup();
  }
  await document.destroy();
  const facts = metrics.map((m) => {
    const f = numberCandidate(pages[0], m, 100, period);
    f.unit = '万円';
    return f;
  });
  const rate = numberCandidate(pages[1], '売上高営業利益率', 10, historical);
  rate.unit = '%';
  rate.semantics.metricKind = 'rate';
  const background = numberCandidate(pages[2], '純損失', 100, period);
  background.kind = 'event';
  background.label = background.statement = background.quote;
  background.value = background.unit = background.valueKind = background.period = null;
  background.semantics.periodKind = 'none';
  background.semantics.metricKind = 'none';
  background.semantics.state = 'forecast';
  background.semantics.polarity = 'negative';
  background.semantics.qualifiers = ['概算額'];
  for (const f of [rate, background]) {
    f.semantics.scope = '個別';
    f.semantics.basis = 'IFRS';
  }
  facts.push(rate, background);
  const context = buildDocumentContext(pages);
  facts.forEach((f, i) => {
    const binding = bindingFor(context, f.evidence.kind === 'prose' ? f.evidence.blockId : '');
    f.id = `f${i + 1}`;
    f.evidence.contextIds = binding.contextIds;
    f.evidence.qualifierIds = binding.qualifierIds;
    f.evidence.scopeIds = resolveScopeIds(binding, f.semantics, true);
  });
  const checked = parseFactSummary(
    JSON.stringify({ version: 4, documentType: 'earnings', facts, unverified: [] }),
    'earnings',
    pages
  );
  if (checked.unverified.length || checked.facts.length !== 5)
    throw Error(JSON.stringify(checked.unverified));
  const wrong = structuredClone(facts);
  wrong[0].semantics.metricKind = 'count';
  wrong[4].semantics.state = 'unspecified';
  const first = candidateResponse(wrong, pages, 'earnings');
  if (reviewCandidates(first, 'earnings', pages).facts.length !== 3)
    throw Error('initial wrong meaning was not rejected');
  const legacy = structuredClone(checked);
  legacy.facts[4].semantics.state = 'unspecified';
  legacy.facts[4].id = stableFactId(legacy.facts[4]);
  return {
    pdf,
    pages,
    documentType: 'earnings' as DocumentType,
    repairRequired: true,
    first,
    repair: candidateResponse([facts[0], facts[4]], pages, 'earnings'),
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [],
    expected: ['売上高: 100万円', '売上高営業利益率: 10%', historical, body, '個別', 'IFRS'],
  };
}

async function periodOutlookUnitsFixture(semanticOwnership = false) {
  const period = '2027年3月期',
    historical = '2026年3月期';
  const current = period + (semanticOwnership ? '第2四半期累計' : '第3四半期累計');
  const interval = '2026年4月1日～2026年4月30日';
  const bounded = '取得価額は100百万円以内です。';
  const modalStatement = '当社はAを取得しないことを決定しました。';
  const lossPlan = '当該額は2028年3月期に特別損失に計上する予定です。';
  const annualForecast = '2028年3月期通期の売上高は100万円を見込んでおります。';
  const incidentalPlan =
    '2029年3月期の業績予想を参照しましたが、当該額は特別損失に計上する予定です。';
  const metrics = ['売上高', '営業利益', '当期純利益'];
  const body = '親会社株主に帰属する当期純損失は概算額100万円となる見通しはありません。';
  const texts = [
    `${period} 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${metrics.map((m) => `${period}の${m}は100万円です。`).join('\n')}`,
    `1. ${historical} 経営成績\n範囲 個別\n会計基準 IFRS\n\t2025年3月期\t${historical}\n売上高営業利益率\t8%\t10%`,
    `2. 損失予想の背景\n範囲 個別\n会計基準 IFRS\n${body}`,
    `3. ${period} 販売状況\n販売数量は100台です。`,
    `(1) 株式会社他社の概要\n経営成績\n\t2026年3月期\t2027年3月期\n売上高\t100百万円\t200百万円`,
    `営業利益\t10百万円\t20百万円\n当期純利益\t8百万円\t16百万円`,
    `4. 配当の状況\n\t年間配当金\t期末配当金\n\t円\t円\n2027年3月期(予想)\t12\t12`,
  ];
  if (semanticOwnership) {
    texts[0] = `${period} 2Q（中間期）決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n1. ${current} 経営成績\n${metrics.map((m) => `${current}期間の${m}は100万円です。`).join('\n')}`;
    texts[1] = `1. ${current} 単体累計期間の業績\n範囲 単体\n会計基準 IFRS\n\t2026年3月期第2四半期累計\t${current}\n売上高営業利益率\t8%\t10%`;
    texts[6] = `4. 配当の状況（予想）\n\t年間配当金\t期末配当金\n\t円\t円\n${period}\t12\t12`;
    texts.push(
      `5. ${period} 取引概要\n${bounded}`,
      `6. 経営成績\n\t販売件数\t人数\n\t件\t人\n${interval}\t100\t20`,
      `7. 取引概要\n${modalStatement}`,
      `8. ${period} 配当の状況\n中間配当金は10円50銭です。`,
      `9. ${period}中間期 販売状況\n販売台数は100台です。`,
      `10. 今後の予定\n${lossPlan}`,
      `11. 取引概要\n${annualForecast}`,
      `12. 今後の予定\n${incidentalPlan}`
    );
    texts[3] = `3. ${period} 販売状況\n販売数量は100千kWhです。`;
  }
  const pdf = textPdf(texts, semanticOwnership ? [30, 360, 650] : undefined);
  const document = await getDocument({ data: pdf.slice(), disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= document.numPages; n++) {
    const p = await document.getPage(n);
    pages.push(extractPageLayout((await p.getTextContent()).items, n));
    p.cleanup();
  }
  await document.destroy();
  const context = buildDocumentContext(pages);
  const facts = metrics.map((m) => {
    const f = numberCandidate(pages[0], m, 100, semanticOwnership ? current : period);
    f.unit = '万円';
    if (semanticOwnership) f.semantics.periodKind = 'cumulativeQ2';
    return f;
  });
  const tableFact = (
    pageIndex: number,
    label: string,
    value: number,
    unit: string,
    state: 'actual' | 'forecast',
    target: string
  ) => {
    const h = context.tableMappings.find(
      (h) =>
        pages[pageIndex].quantities.some(
          (q) => q.id === h.valueId && Number(q.text.replace(/[^\d.]/g, '')) === value
        ) &&
        h.metricIds
          .map((id) => pages.flatMap((p) => p.spans).find((s) => s.id === id)!.text)
          .join('') === label
    );
    if (!h) throw Error(`mapping missing: ${label}`);
    const f = numberCandidate(pages[0], '売上高', value, target);
    f.page = pageIndex + 1;
    f.label = label;
    f.unit = unit;
    f.valueKind = f.semantics.state = state;
    f.evidence = { kind: 'table', ...h, scopeIds: [], qualifierIds: [] };
    return f;
  };
  const rate = tableFact(
    1,
    '売上高営業利益率',
    10,
    '%',
    'actual',
    semanticOwnership ? current : historical
  );
  if (semanticOwnership) rate.semantics.periodKind = 'cumulativeQ2';
  rate.semantics.metricKind = 'rate';
  rate.semantics.scope = semanticOwnership ? '単体' : '個別';
  rate.semantics.basis = 'IFRS';
  const background = numberCandidate(pages[2], '純損失', 100, period);
  background.kind = 'event';
  background.label = background.statement = background.quote;
  background.value = background.unit = background.valueKind = background.period = null;
  background.semantics.periodKind = 'none';
  background.semantics.metricKind = 'none';
  background.semantics.state = 'forecast';
  background.semantics.polarity = 'negative';
  background.semantics.qualifiers = ['概算額'];
  background.semantics.scope = '個別';
  background.semantics.basis = 'IFRS';
  const count = numberCandidate(pages[3], '販売数量', 100, period);
  count.unit = semanticOwnership ? '千kWh' : '台';
  count.semantics.metricKind = 'other';
  count.semantics.scope = count.semantics.basis = null;
  const dividend = tableFact(6, '年間配当金', 12, '円', 'forecast', period);
  dividend.semantics.metricKind = 'perShare';
  dividend.semantics.scope = dividend.semantics.basis = null;
  facts.push(rate, background, count, dividend);
  if (semanticOwnership) {
    const bound = numberCandidate(pages[7], '取得価額', 100, period);
    bound.kind = 'event';
    bound.label = bound.statement = bound.quote;
    bound.value = bound.unit = bound.valueKind = bound.period = null;
    bound.semantics.metricKind = 'none';
    bound.semantics.periodKind = 'none';
    bound.semantics.state = 'unspecified';
    bound.semantics.scope = bound.semantics.basis = null;
    const countInterval = tableFact(8, '販売件数', 100, '件', 'actual', interval);
    countInterval.semantics.metricKind = 'count';
    countInterval.semantics.periodKind = 'interval';
    facts.push(bound, countInterval);
    const modal = numberCandidate(pages[9], '当社');
    modal.kind = 'event';
    modal.label = modal.statement = modal.quote;
    modal.value = modal.unit = modal.valueKind = modal.period = null;
    modal.semantics.metricKind = 'none';
    modal.semantics.periodKind = 'none';
    modal.semantics.state = 'decided';
    modal.semantics.polarity = 'negative';
    modal.semantics.scope = modal.semantics.basis = null;
    const yen = numberCandidate(pages[10], '中間配当金', 10.5, period);
    yen.unit = '円';
    yen.semantics.metricKind = 'perShare';
    yen.semantics.scope = yen.semantics.basis = null;
    const alias = numberCandidate(pages[11], '販売台数', 100, period + '中間期');
    alias.unit = '台';
    alias.semantics.metricKind = 'other';
    alias.semantics.periodKind = 'cumulativeQ2';
    alias.semantics.scope = alias.semantics.basis = null;
    facts.push(modal, yen, alias);
    const planned = numberCandidate(pages[12], '特別損失', 100, '2028年3月期');
    planned.kind = 'event';
    planned.label = planned.statement = planned.quote;
    planned.value = planned.unit = planned.valueKind = null;
    planned.semantics.metricKind = 'none';
    planned.semantics.state = 'planned';
    planned.semantics.scope = '連結';
    planned.semantics.basis = '日本基準';
    const forecast = numberCandidate(pages[13], '売上高', 100, '2028年3月期通期');
    forecast.unit = '万円';
    forecast.valueKind = forecast.semantics.state = 'forecast';
    forecast.semantics.scope = forecast.semantics.basis = null;
    const incidental = numberCandidate(pages[14], '特別損失');
    incidental.kind = 'event';
    incidental.label = incidental.statement = incidental.quote;
    incidental.value = incidental.unit = incidental.valueKind = incidental.period = null;
    incidental.semantics.metricKind = 'none';
    incidental.semantics.periodKind = 'none';
    incidental.semantics.state = 'planned';
    facts.push(planned, forecast, incidental);
  }
  facts.forEach((f, i) => {
    const binding = bindingFor(
      context,
      f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.blockId
    );
    f.id = `f${i + 1}`;
    f.evidence.contextIds = binding.contextIds;
    f.evidence.qualifierIds = binding.qualifierIds;
    f.evidence.scopeIds = resolveScopeIds(binding, f.semantics, isFinancialUnit(f, binding, pages));
  });
  const checked = parseFactSummary(
    JSON.stringify({
      version: 4,
      documentType: 'earnings',
      facts: reviewCandidates(candidateResponse(facts, pages, 'earnings'), 'earnings', pages).facts,
      unverified: [],
    }),
    'earnings',
    pages
  );
  if (checked.unverified.length || checked.facts.length !== facts.length)
    throw Error(JSON.stringify(checked.unverified));
  const wrong = structuredClone(facts);
  wrong[0].semantics.metricKind = 'count';
  wrong[4].semantics.state = 'unspecified';
  const firstFacts = wrong.filter((_, i) => i !== 6);
  if (semanticOwnership) {
    const f = numberCandidate(pages[7], '取得価額', 100, period);
    f.semantics.scope = f.semantics.basis = null;
    firstFacts[6] = f;
    wrong[9].semantics.polarity = 'affirmative';
    wrong[12].semantics.periodKind = 'relativeYear';
    wrong[14].period = '2029年3月期';
    wrong[14].semantics.periodKind = 'fullYear';
    // firstFacts already shares wrong[9]; an equivalent period spelling adds no fact.
    const alias = structuredClone(facts[11]);
    alias.period = period + '第2四半期';
    firstFacts.push(alias);
  }
  const first = candidateResponse(firstFacts, pages, 'earnings');
  if (reviewCandidates(first, 'earnings', pages).facts.length !== (semanticOwnership ? 8 : 4))
    throw Error('initial wrong meaning was not rejected');
  const legacy = structuredClone(checked);
  legacy.facts[4].semantics.state = 'unspecified';
  legacy.facts[4].id = stableFactId(legacy.facts[4]);
  return {
    pdf,
    pages,
    documentType: 'earnings' as DocumentType,
    repairRequired: true,
    first,
    repair: candidateResponse(
      [
        facts[0],
        facts[4],
        facts[6],
        ...(semanticOwnership ? [facts[7], facts[9], facts[12], facts[14]] : []),
      ],
      pages,
      'earnings'
    ),
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [],
    expected: [
      '売上高: 100万円',
      '売上高営業利益率: 10%',
      semanticOwnership ? current : historical,
      ...(semanticOwnership ? [bounded, interval, '販売件数: 100件'] : []),
      body,
      semanticOwnership ? '販売数量: 100千kWh' : '販売数量: 100台',
      ...(semanticOwnership
        ? [
            '中間配当金: 10.50円',
            modalStatement,
            incidentalPlan,
            '販売台数: 100台',
            lossPlan,
            annualForecast.replace('の売上高は100万円を見込んでおります。', ''),
            '単体',
          ]
        : []),
      '年間配当金: 12円',
      '個別',
      'IFRS',
    ],
  };
}
