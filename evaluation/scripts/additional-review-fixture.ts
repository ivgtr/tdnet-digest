import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPageLayout } from '../../src/lib/pdf-layout';
import { numberCandidate } from '../../src/lib/fixtures/v4-test-source';
import { buildDocumentContext, bindingFor, resolveScopeIds } from '../../src/lib/document-context';
import { assertionPolarity } from '../../src/lib/assertion-semantics';
import { candidateResponse } from '../../src/lib/fixtures/candidate-test-source';
import { stableFactId, type VerifiedFact, type FactSummary } from '../../src/lib/fact-contract';
import { parseFactSummary, renderFacts } from '../../src/lib/fact-summary';
import type { DocumentType } from '../../src/lib/document-type';

/** Deterministic text PDF, not an offscreen mock: PDF.js must recover these physical pages. */
function textPdf(texts: string[]): Uint8Array {
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
          .map(
            (line, i) =>
              `BT /F1 10 Tf 1 0 0 1 30 ${800 - i * 24 + (/^\(2\)/.test(line) ? 4 : 0)} Tm <${hex(line)}> Tj ET`
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
  if (['semantics', 'cover-outlook', 'metric-repair'].includes(mode))
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
  const period = '2027年3月期';
  const documentType: DocumentType = mode === 'cover-outlook' ? 'earnings' : 'other';
  const metrics = ['売上高', '営業利益', '当期純利益'];
  const bodies = [
    '当社は取得を予定しておりません。',
    '当社はAを取得しましたが、Bは取得していません。',
  ];
  const texts =
    mode === 'cover-outlook'
      ? [
          `${period} 決算短信〔日本基準〕（連結）\n会社名 株式会社テスト\n${period}の通期業績予想について説明します。\n${metrics.map((m) => `${period}の${m}は100百万円です。`).join('\n')}`,
          `1. 今後の見通し\n範囲 個別\n会計基準 IFRS\n${metrics.map((m) => `${period}の${m}は100百万円の見込みです。`).join('\n')}`,
        ]
      : mode === 'semantics'
        ? ['会社名 株式会社テスト', ...bodies.map((body) => `1. 事業説明\n${body}`)]
        : [
            '会社名 株式会社テスト',
            `1. ${period} 業績予想\n${period}の売上高は100百万円の見込みです。`,
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
  const facts: VerifiedFact[] = [];
  for (const page of mode === 'cover-outlook' ? pages : pages.slice(1)) {
    for (const metric of mode === 'semantics'
      ? ['当社']
      : mode === 'cover-outlook'
        ? metrics
        : ['売上高']) {
      const f = numberCandidate(page, metric, 100, period);
      f.semantics.scope =
        mode === 'cover-outlook' ? (page.pageNumber === 1 ? '連結' : '個別') : null;
      f.semantics.basis =
        mode === 'cover-outlook' ? (page.pageNumber === 1 ? '日本基準' : 'IFRS') : null;
      if (mode === 'semantics') {
        f.kind = 'event';
        f.label = f.statement = f.quote;
        f.value = f.unit = f.valueKind = null;
        f.period = null;
        f.semantics.periodKind = 'none';
        f.semantics.metricKind = 'none';
        f.semantics.state = page.pageNumber === 2 ? 'unspecified' : 'completed';
        f.semantics.polarity = page.pageNumber === 2 ? 'negative' : 'mixed';
      } else
        f.valueKind = f.semantics.state =
          mode === 'cover-outlook' && page.pageNumber === 1 ? 'actual' : 'forecast';
      const binding = bindingFor(context, f.evidence.kind === 'prose' ? f.evidence.blockId : '');
      f.evidence.contextIds = binding.contextIds;
      f.evidence.scopeIds = resolveScopeIds(binding, f.semantics, mode === 'cover-outlook');
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
  if (mode === 'semantics') {
    wrong[0].semantics.state = 'planned';
    wrong[0].semantics.polarity = 'affirmative';
    wrong[1].semantics.polarity = 'negative';
  } else if (mode === 'cover-outlook')
    wrong.slice(0, 3).forEach((f) => {
      f.semantics.scope = f.semantics.basis = null;
    });
  else wrong[0].semantics.scope = '連結';
  const first = JSON.parse(candidateResponse(wrong, pages, documentType));
  if (mode === 'metric-repair') first.candidates[0].source.metric = '売上 高';
  const legacy = structuredClone(checked);
  if (mode === 'semantics')
    legacy.facts.forEach((f, i) => {
      f.semantics = wrong[i].semantics;
      f.id = stableFactId(f);
    });
  else if (mode === 'cover-outlook')
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
    repair: candidateResponse(
      mode === 'cover-outlook' ? facts.slice(0, 3) : facts,
      pages,
      documentType
    ),
    legacy,
    legacyRendered: renderFacts(legacy),
    warnings: [] as string[],
    expected:
      mode === 'semantics'
        ? bodies
        : mode === 'cover-outlook'
          ? ['連結', '日本基準', '個別', 'IFRS', '売上高: 100百万円']
          : ['売上高: 100百万円'],
  };
}
