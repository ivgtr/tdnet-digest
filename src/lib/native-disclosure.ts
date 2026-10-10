import {
  compactNativeDisclosure,
  projectCompactNativeInput,
  type NativeModelInput,
} from './native-disclosure-model';
export type { NativeModelInput } from './native-disclosure-model';
import { canonicalJSON, hashText, record } from './fact-contract';
import { readNativeArchive, safeArchivePath } from './native-disclosure-archive';
import {
  NATIVE_DISCLOSURE_VERSION,
  NATIVE_LIMITS,
  normalizeSecurityCode,
  validateNativeCompanionRef,
  type NativeCompanionRef,
  type NativeDisclosure,
  type NativeFact,
  type NativeContext,
  type NativeUnit,
  type NativeQName,
} from './native-disclosure-contract';
import {
  XBRLI,
  XSI,
  TSE,
  elements,
  allElements,
  isInline,
  parseInertXml,
  parseContext,
  parseUnit,
  sameContext,
  qname,
  expanded,
  qualifiedId,
  tidyText,
  exactNumber,
  exactText,
  validNativeDate,
} from './native-disclosure-xml';
import { cellReference, parseNativeHtml } from './native-disclosure-html';
export * from './native-disclosure-contract';

type ParsedDocument = {
  file: string;
  documentSetId: string;
  kind: 'ixbrl' | 'html';
  doc: Document;
};
function documentSets(files: Map<string, string>): ParsedDocument[] {
  const parsed = new Map<string, Document>();
  let nodeCount = 0;
  // Refuse declarations in every XML-like file, even when it is not a consumed taxonomy.
  for (const [file, text] of files) {
    if (/<!DOCTYPE|<!ENTITY/i.test(text))
      throw new Error('NATIVE:DTD・外部エンティティは使用できません');
    if (/\.(?:xhtml|html?)$/i.test(file) || /\/manifest\.xml$/i.test(file)) {
      const doc = parseInertXml(text);
      nodeCount += allElements(doc).length;
      if (nodeCount > NATIVE_LIMITS.nodes)
        throw new Error('NATIVE:文書セットの要素数上限を超えました');
      parsed.set(file, doc);
    }
  }
  const assignments = new Map<string, string>();
  for (const [file, doc] of parsed) {
    if (!/\/manifest\.xml$/i.test(file)) continue;
    const folder = file.slice(0, file.lastIndexOf('/') + 1);
    const instances = allElements(doc).filter((el) => el.localName === 'instance');
    if (!instances.length) throw new Error('NATIVE:manifestの文書セットがありません');
    for (const [index, instance] of instances.entries()) {
      const refs = allElements(instance).filter((el) => el.localName === 'ixbrl');
      if (!refs.length) throw new Error('NATIVE:manifestにiXBRL文書がありません');
      for (const ref of refs) {
        const relative = safeArchivePath(ref.textContent?.trim() || '');
        const target = safeArchivePath(folder + relative);
        if (!parsed.has(target) || assignments.has(target))
          throw new Error('NATIVE:manifestの文書参照が不正・重複しています');
        assignments.set(target, `${file}:set-${index + 1}`);
      }
    }
  }
  const documents: ParsedDocument[] = [];
  for (const [file, doc] of parsed) {
    if (/\/manifest\.xml$/i.test(file)) continue;
    const inline = allElements(doc).some(isInline);
    if (!/^XBRLData\/(Summary|Attachment)\/[^/]+\.(?:xhtml|html?)$/i.test(file))
      throw new Error('NATIVE:未対応のHTML配置です');
    let documentSetId = assignments.get(file);
    if (inline && !documentSetId) {
      if (!file.startsWith('XBRLData/Summary/'))
        throw new Error('NATIVE:添付iXBRLの文書セットを確定できません');
      documentSetId = `${file}:summary`;
    }
    documents.push({
      file,
      documentSetId: documentSetId || `${file}:html`,
      kind: inline ? 'ixbrl' : 'html',
      doc,
    });
  }
  if (!documents.some((d) => d.file.startsWith('XBRLData/Summary/') && d.kind === 'ixbrl'))
    throw new Error('NATIVE:開示識別用のサマリーiXBRLがありません');
  return documents;
}
function resolveDefinitions(documents: ParsedDocument[]) {
  const contexts = new Map<string, NativeContext>(),
    units = new Map<string, NativeUnit>();
  for (const { file, documentSetId: set, doc } of documents) {
    for (const el of elements(doc, XBRLI, 'context')) {
      const context = parseContext(el, set, file),
        previous = contexts.get(context.id);
      if (previous && !sameContext(previous, context))
        throw new Error('NATIVE:同じ文書セットの文脈定義が矛盾しています');
      if (previous) previous.sourceFiles.push(file);
      else contexts.set(context.id, context);
    }
    for (const el of elements(doc, XBRLI, 'unit')) {
      const unit = parseUnit(el, set),
        previous = units.get(unit.id);
      if (previous && canonicalJSON(previous) !== canonicalJSON(unit))
        throw new Error('NATIVE:同じ文書セットの単位定義が矛盾しています');
      units.set(unit.id, unit);
    }
  }
  return { contexts, units };
}
function factText(el: Element, set: string, continuation: Map<string, Element>): string {
  let result = tidyText(el),
    current = el;
  const visited = new Set<Element>([el]);
  while (current.hasAttribute('continuedAt')) {
    const next = continuation.get(qualifiedId(set, current.getAttribute('continuedAt')!));
    if (!next || visited.has(next) || visited.size > 100)
      throw new Error('NATIVE:iXBRLの継続参照が不正です');
    visited.add(next);
    result += tidyText(next);
    current = next;
  }
  return result;
}
function parseFacts(
  documents: ParsedDocument[],
  contexts: Map<string, NativeContext>,
  units: Map<string, NativeUnit>
) {
  const facts: NativeFact[] = [],
    tables: NativeDisclosure['tables'] = [],
    passages: NativeDisclosure['passages'] = [];
  const continuations = new Map<string, Element>();
  const htmlBudget = { cells: 0, slots: 0 };
  for (const { documentSetId: set, doc } of documents)
    for (const el of allElements(doc)) {
      if (isInline(el) && el.localName === 'continuation') {
        const id = el.getAttribute('id');
        if (!id || continuations.has(qualifiedId(set, id)))
          throw new Error('NATIVE:継続参照IDが重複しています');
        continuations.set(qualifiedId(set, id), el);
      }
    }
  for (const { file, documentSetId: set, doc } of documents) {
    const html = parseNativeHtml(doc, file, htmlBudget);
    tables.push(...html.tables);
    passages.push(...html.passages);
    if (tables.reduce((count, table) => count + table.cells.length, 0) > NATIVE_LIMITS.tableCells)
      throw new Error('NATIVE:全体の表サイズ上限を超えました');
    let index = 0;
    for (const el of allElements(doc)) {
      if (!isInline(el) || !['nonFraction', 'nonNumeric', 'fraction'].includes(el.localName))
        continue;
      if (facts.length >= NATIVE_LIMITS.facts)
        throw new Error('NATIVE:原文事実数の上限を超えました');
      const concept = qname(el, el.getAttribute('name'));
      const contextId = qualifiedId(set, el.getAttribute('contextRef') || '');
      const number = el.localName !== 'nonNumeric';
      const unitId = number ? qualifiedId(set, el.getAttribute('unitRef') || '') : null;
      if (!contexts.has(contextId) || (unitId && !units.has(unitId)))
        throw new Error('NATIVE:文脈または単位の参照を解決できません');
      const scaleLiteral = el.getAttribute('scale') || '0';
      if (!/^-?\d{1,2}$/.test(scaleLiteral) || Math.abs(Number(scaleLiteral)) > 18)
        throw new Error('NATIVE:未対応の数値scaleです');
      const scale = Number(scaleLiteral),
        signAttr = el.getAttribute('sign');
      if (signAttr !== null && signAttr !== '-') throw new Error('NATIVE:数値の符号属性が不正です');
      const sign = signAttr as '-' | null;
      const nilAttr = el.getAttributeNS(XSI, 'nil');
      if (nilAttr !== null && !['true', 'false', '1', '0'].includes(nilAttr))
        throw new Error('NATIVE:nil属性が不正です');
      const nil = nilAttr === 'true' || nilAttr === '1';
      const literal = factText(el, set, continuations);
      const transformation = el.hasAttribute('format')
        ? qname(el, el.getAttribute('format'))
        : null;
      const format = transformation ? expanded(el, el.getAttribute('format')) : null;
      let tuple = el.parentElement;
      while (tuple && !(isInline(tuple) && tuple.localName === 'tuple'))
        tuple = tuple.parentElement;
      const value =
        nil || el.localName === 'fraction' || tuple
          ? null
          : number
            ? exactNumber(literal, scale, sign, transformation)
            : exactText(literal, transformation);
      facts.push({
        id: `${file}#fact-${++index}`,
        documentSetId: set,
        file,
        concept,
        contextId,
        unitId,
        kind: number ? 'number' : 'text',
        literal,
        value,
        status: nil ? 'nil' : value === null ? 'unsupported' : 'parsed',
        scale,
        sign,
        decimals: el.getAttribute('decimals'),
        format,
        ...cellReference(el, html.cellRefs),
      });
    }
  }
  return { facts, tables, passages };
}
const compact = (value: string) => value.normalize('NFKC').replace(/\s/g, '');
const issuerName = (value: string) => compact(value).replace(/株式会社|有限会社/g, '');
function filingDate(value: string): string | null {
  const text = compact(value),
    m = text.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/);
  return m
    ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
    : /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? text
      : null;
}
function assessIdentity(
  source: NativeCompanionRef,
  facts: NativeFact[],
  contexts: NativeContext[],
  pdfText?: string
) {
  const reasons: string[] = [];
  const metadata = (name: string) =>
    facts.filter(
      (f) =>
        f.file.startsWith('XBRLData/Summary/') &&
        f.concept.namespace === TSE &&
        f.concept.localName === name &&
        f.status === 'parsed'
    );
  const dates = new Set(metadata('FilingDate').map((f) => filingDate(f.literal)));
  const codes = new Set(metadata('SecuritiesCode').map((f) => normalizeSecurityCode(f.literal)));
  const names = new Set(metadata('CompanyName').map((f) => issuerName(f.literal)));
  const expectedCode = normalizeSecurityCode(source.code);
  if (source.correction)
    reasons.push('訂正履歴がある開示のHTML/XBRLは更新済みと確認できないためPDFを使用します');
  if (dates.size !== 1 || !dates.has(source.publishedDate))
    reasons.push('XBRLの提出日と選択した開示行の公表日が一致しません');
  if (codes.size !== 1 || !codes.has(expectedCode))
    reasons.push('XBRLの証券コードと開示行が一致しません');
  if (
    !contexts.length ||
    contexts.some(
      (c) =>
        c.entity.scheme !== 'http://www.tse.or.jp/sicc' ||
        normalizeSecurityCode(c.entity.identifier) !== expectedCode
    )
  )
    reasons.push('XBRL文書セットの主体が選択した会社と一致しません');
  let pdfIdentity: NativeDisclosure['consistency']['pdfIdentity'] = 'unverified';
  if (!pdfText) reasons.push('PDF本文でXBRLの主体・公表日を照合できません');
  else {
    const pdf = compact(pdfText);
    const [year, month, day] = source.publishedDate.split('-');
    const dateMatch =
      pdf.includes(`${year}年${Number(month)}月${Number(day)}日`) ||
      pdf.includes(source.publishedDate);
    const codeMatch = new RegExp(
      `(?:コード(?:番号)?[：:]?|証券コード[：:]?|[（(])${expectedCode}(?:0)?(?:[）)]|[^0-9]|$)`,
      'i'
    ).test(pdf);
    const nameMatch =
      names.size === 1 &&
      [...names].every((name) => name.length > 1 && issuerName(pdf).includes(name));
    pdfIdentity = dateMatch && codeMatch && nameMatch ? 'matched' : 'mismatch';
    if (pdfIdentity === 'mismatch')
      reasons.push('PDF本文とXBRLの会社名・証券コード・公表日を一致確認できません');
  }
  return { reasons, consistency: { pdfIdentity, numeric: 'not-compared' as const } };
}
export function nativeDisclosureChecksum(value: Omit<NativeDisclosure, 'checksum'>): string {
  return hashText(canonicalJSON(value));
}
/** No network or executing markup. Call in the extension offscreen document, after bounded download. */
export async function parseNativeDisclosureArchive(
  bytes: Uint8Array,
  ref: NativeCompanionRef,
  options: { pdfText?: string } = {}
): Promise<NativeDisclosure> {
  const source = validateNativeCompanionRef(ref);
  const documents = documentSets(readNativeArchive(bytes));
  const { contexts, units } = resolveDefinitions(documents);
  const parsed = parseFacts(documents, contexts, units);
  const identity = assessIdentity(source, parsed.facts, [...contexts.values()], options.pdfText);
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
    (b) => b.toString(16).padStart(2, '0')
  ).join('');
  const unsupported = parsed.facts.filter((f) => f.status === 'unsupported').length;
  const body: Omit<NativeDisclosure, 'checksum'> = {
    version: NATIVE_DISCLOSURE_VERSION,
    hash,
    source,
    status: identity.reasons.length ? 'ineligible' : 'eligible',
    ...identity,
    documents: documents.map(({ file, documentSetId, kind }) => ({ file, documentSetId, kind })),
    contexts: [...contexts.values()],
    units: [...units.values()],
    ...parsed,
    warnings: [
      'PDFとの照合は主体・公表日の一致確認です。数値・説明の意味や全訂正履歴の一致は未確認です。',
      ...(unsupported
        ? [`未対応の変換・構造を持つ${unsupported}件は原文を保持し、数値として使用しません。`]
        : []),
    ],
  };
  return { ...body, checksum: nativeDisclosureChecksum(body) };
}

const strings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');
const nullableString = (v: unknown) => v === null || typeof v === 'string';
const unique = (values: Array<{ id: string }>) =>
  new Set(values.map((v) => v.id)).size === values.length;
const fromExpanded = (value: string | null): NativeQName | null => {
  if (value === null) return null;
  const m = value.match(/^\{([^}]+)\}([^{}]+)$/);
  if (!m) throw new Error('NATIVE:保存された変換名が不正です');
  return { namespace: m[1], localName: m[2], qname: m[2] };
};
/** Recheck persisted evidence before model input or cache reuse. It is still source, not verified assertions. */
export function validateNativeDisclosure(value: unknown): NativeDisclosure {
  const fail = (): never => {
    throw new Error('NATIVE:保存された原文データが不正です');
  };
  if (
    !record(value) ||
    value.version !== NATIVE_DISCLOSURE_VERSION ||
    typeof value.hash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.hash) ||
    !['eligible', 'ineligible'].includes(String(value.status)) ||
    !strings(value.reasons) ||
    !strings(value.warnings) ||
    !record(value.consistency) ||
    !['matched', 'unverified', 'mismatch'].includes(String(value.consistency.pdfIdentity)) ||
    value.consistency.numeric !== 'not-compared' ||
    !Array.isArray(value.documents) ||
    !Array.isArray(value.contexts) ||
    !Array.isArray(value.units) ||
    !Array.isArray(value.facts) ||
    !Array.isArray(value.tables) ||
    !Array.isArray(value.passages) ||
    typeof value.checksum !== 'string'
  )
    return fail();
  const source = validateNativeCompanionRef(value.source);
  if (
    value.status === 'eligible' &&
    (value.reasons.length || source.correction || value.consistency.pdfIdentity !== 'matched')
  )
    return fail();
  const v = value as unknown as NativeDisclosure;
  if (v.documents.length > NATIVE_LIMITS.entries || v.facts.length > NATIVE_LIMITS.facts)
    return fail();
  if (
    !v.documents.every(
      (d) =>
        record(d) &&
        typeof d.file === 'string' &&
        typeof d.documentSetId === 'string' &&
        ['ixbrl', 'html'].includes(d.kind)
    )
  )
    return fail();
  const files = new Set(v.documents.map((d) => safeArchivePath(d.file)));
  if (files.size !== v.documents.length) return fail();
  if (
    !v.contexts.every(
      (c) =>
        record(c) &&
        typeof c.id === 'string' &&
        typeof c.documentSetId === 'string' &&
        strings(c.sourceFiles) &&
        c.sourceFiles.every((f) => files.has(f)) &&
        record(c.entity) &&
        typeof c.entity.identifier === 'string' &&
        typeof c.entity.scheme === 'string' &&
        record(c.period) &&
        ['start', 'end', 'instant'].every((key) =>
          nullableString(c.period[key as keyof typeof c.period])
        ) &&
        Array.isArray(c.dimensions) &&
        strings(c.otherContent) &&
        c.dimensions.every(
          (d) =>
            record(d) &&
            typeof d.axis === 'string' &&
            nullableString(d.member) &&
            nullableString(d.typedValue)
        ) &&
        [null, 'actual', 'forecast'].includes(c.valueKind) &&
        [null, 'consolidated', 'nonconsolidated'].includes(c.consolidation)
    ) ||
    !unique(v.contexts)
  )
    return fail();
  if (
    !v.units.every(
      (u) =>
        record(u) &&
        typeof u.id === 'string' &&
        typeof u.documentSetId === 'string' &&
        strings(u.numerator) &&
        strings(u.denominator)
    ) ||
    !unique(v.units)
  )
    return fail();
  const contexts = new Map(v.contexts.map((c) => [c.id, c])),
    units = new Map(v.units.map((u) => [u.id, u]));
  if (
    !v.facts.every(
      (f) =>
        record(f) &&
        typeof f.id === 'string' &&
        typeof f.file === 'string' &&
        files.has(f.file) &&
        typeof f.documentSetId === 'string' &&
        record(f.concept) &&
        ['qname', 'namespace', 'localName'].every(
          (key) => typeof f.concept[key as keyof NativeQName] === 'string'
        ) &&
        typeof f.contextId === 'string' &&
        contexts.get(f.contextId)?.documentSetId === f.documentSetId &&
        nullableString(f.unitId) &&
        (f.unitId === null || units.get(f.unitId)?.documentSetId === f.documentSetId) &&
        ['number', 'text'].includes(f.kind) &&
        (f.kind === 'number') === (f.unitId !== null) &&
        v.documents.find((d) => d.file === f.file)?.documentSetId === f.documentSetId &&
        typeof f.literal === 'string' &&
        nullableString(f.value) &&
        ['parsed', 'nil', 'unsupported'].includes(f.status) &&
        Number.isInteger(f.scale) &&
        Math.abs(f.scale) <= 18 &&
        [null, '-'].includes(f.sign) &&
        [f.decimals, f.format, f.rowText, f.tableId, f.cellId].every(nullableString) &&
        (f.status === 'parsed'
          ? f.value !== null &&
            f.value ===
              (f.kind === 'number'
                ? exactNumber(f.literal, f.scale, f.sign, fromExpanded(f.format))
                : exactText(f.literal, fromExpanded(f.format)))
          : f.value === null)
    )
  )
    return fail();
  if (!unique(v.facts)) return fail();
  for (const c of v.contexts) {
    const p = c.period;
    const state = c.dimensions.find((d) => d.axis === `{${TSE}}ResultForecastAxis`)?.member;
    const scope = c.dimensions.find(
      (d) => d.axis === `{${TSE}}ConsolidatedNonconsolidatedAxis`
    )?.member;
    if (
      !Object.values(p).every(validNativeDate) ||
      !(
        (p.start && p.end && !p.instant && p.start <= p.end) ||
        (p.instant && !p.start && !p.end)
      ) ||
      new Set(c.dimensions.map((d) => d.axis)).size !== c.dimensions.length ||
      c.valueKind !==
        (state === `{${TSE}}ResultMember`
          ? 'actual'
          : state === `{${TSE}}ForecastMember`
            ? 'forecast'
            : null) ||
      c.consolidation !==
        (scope === `{${TSE}}ConsolidatedMember`
          ? 'consolidated'
          : scope === `{${TSE}}NonconsolidatedMember`
            ? 'nonconsolidated'
            : null)
    )
      return fail();
  }
  if (
    !v.tables.every(
      (t) =>
        record(t) &&
        typeof t.id === 'string' &&
        files.has(t.file) &&
        nullableString(t.caption) &&
        Array.isArray(t.cells) &&
        Array.isArray(t.rows) &&
        t.cells.every(
          (c) =>
            record(c) &&
            typeof c.id === 'string' &&
            [c.row, c.column].every((n) => Number.isInteger(n) && n >= 0) &&
            [c.rowSpan, c.colSpan].every((n) => Number.isInteger(n) && n >= 1 && n <= 200) &&
            ['th', 'td'].includes(c.tag) &&
            typeof c.text === 'string' &&
            strings(c.headers) &&
            nullableString(c.scope)
        ) &&
        t.rows.every(
          (r) =>
            record(r) &&
            typeof r.id === 'string' &&
            Number.isInteger(r.index) &&
            strings(r.cellIds) &&
            typeof r.text === 'string'
        )
    ) ||
    !unique(v.tables)
  )
    return fail();
  if (
    !v.passages.every(
      (p) =>
        record(p) &&
        typeof p.id === 'string' &&
        files.has(p.file) &&
        ['heading', 'paragraph', 'note'].includes(p.kind) &&
        typeof p.text === 'string'
    ) ||
    !unique(v.passages)
  )
    return fail();
  const tableMap = new Map(v.tables.map((t) => [t.id, t]));
  for (const table of v.tables) {
    const cells = new Map(table.cells.map((c) => [c.id, c]));
    if (cells.size !== table.cells.length) return fail();
    for (const row of table.rows) {
      if (
        row.cellIds.some((id) => !cells.has(id)) ||
        row.text !== row.cellIds.map((id) => cells.get(id)!.text).join(' | ')
      )
        return fail();
    }
  }
  for (const fact of v.facts) {
    if (
      fact.tableId === null ? fact.cellId !== null || fact.rowText !== null : fact.cellId === null
    )
      return fail();
    if (fact.tableId !== null) {
      const table = tableMap.get(fact.tableId);
      const row = table?.rows.find((r) => r.cellIds.includes(fact.cellId!));
      if (!table || table.file !== fact.file || !row || row.text !== fact.rowText) return fail();
    }
  }
  const { checksum, ...body } = v;
  if (checksum !== nativeDisclosureChecksum(body)) return fail();
  return v;
}
/** Complete, provenance-bearing source. Callers must budget it explicitly, never silently slice it.
 * Explicit projection prevents unrelated saved fields reaching prompts or diagnostics. */
export function nativeDisclosureModelInput(value: NativeDisclosure) {
  const n = validateNativeDisclosure(value);
  if (n.status !== 'eligible') throw new Error(`NATIVE:${n.reasons.join(' / ')}`);
  return projectNativeModelInput(n);
}
export function projectNativeModelInput(
  n: Omit<NativeDisclosure, 'checksum'> | NativeModelInput
): NativeModelInput {
  return 'encoding' in n ? projectCompactNativeInput(n) : compactNativeDisclosure(n);
}
