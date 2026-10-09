import {
  reportingBasis,
  reportingFieldSegments,
  reportingFieldProjection,
  bracketedReportingBases,
  reportingAttributeKey,
  isReportingAdministrativeRecord,
  isReportingCoverTitle,
  hasReportingCoverTitle,
  reportingValueText,
} from './reporting-attributes';
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { FactSemantics, VerifiedFact } from './fact-contract';
import { NET_PROFIT_METRIC } from './metric-semantics';
import {
  reportingPeriodText,
  reportingPeriodOwner,
  numericValueKind,
  REPORTING_PERIOD_SHAPE_PATTERN,
} from './period-semantics';
import {
  normalized,
  reportingScope,
  reportingScopeHeading,
  isPerformanceReportingTitle,
  forecastReportingTitle,
  forecastPeriodDeclaration,
  forecastTablePeriodSources,
  declaredSubjectsIn,
  headingLevel,
  type TextBlock,
} from './document-structure';
import { buildTableMappings, type TableMapping } from './source-mappings';
import { continuationFor, continuationPage, noteLinks, paragraphNoteLinks } from './document-links';
import { splitNotes, splitNoteApplies } from './source-provenance';

export type DeclarationRole = 'subject' | 'scope' | 'basis';
export interface ContextDeclaration {
  role: DeclarationRole;
  value: string;
  id: string;
  origin: 'document' | 'local';
  financialOnly?: boolean;
  selfOnly?: boolean;
}
export interface ContextBinding {
  id: string;
  page: number;
  anchorId: string;
  blockId: string;
  sectionIds: string[];
  contextIds: string[];
  declarations: ContextDeclaration[];
  qualifierIds: string[];
  requiredPages: number[];
}
export interface DocumentContext {
  bindings: ContextBinding[];
  tableMappings: TableMapping[];
}
const unique = <T>(items: T[]) => [...new Set(items)];
export { declaredSubjectsIn, headingLevel } from './document-structure';
function captionText(block: Pick<TextBlock, 'text'>): string {
  return reportingPeriodText(block.text)
    .replace(/^(?:\(\d+\)|\d+[.．]|■)/, '')
    .replace(/^20\d{2}年\d{1,2}月期(?:の)?/, '')
    .replace(new RegExp(`^(?:${REPORTING_PERIOD_SHAPE_PATTERN})+(?:の)?`), '');
}
function isReportingCover(block: Pick<TextBlock, 'text'>): boolean {
  return (
    hasReportingCoverTitle(block.text) &&
    reportingFieldSegments(block.text).some(isReportingCoverTitle)
  );
}
/** A role field supplies its entire value; a caption needs an explicit reporting object. */
function reportingAttributes(
  block: Pick<TextBlock, 'id' | 'text'> & Partial<Pick<TextBlock, 'kind'>>,
  tableCaption = false
): { role: 'scope' | 'basis'; value: string }[] {
  const attributes: { role: 'scope' | 'basis'; value: string }[] = [];
  const segments = reportingFieldSegments(block.text);
  for (const part of segments) {
    const text = part.trim().replace(/^(?:\(\d+\)|\d+[.．])/, '');
    const field = text.match(/^(範囲|会計基準)(?:\s*:\s*|\s+)([^。；]+)$/);
    if (field) {
      attributes.push({
        role: field[1] === '範囲' ? 'scope' : 'basis',
        value: normalized(field[2]),
      });
      continue;
    }
    const atom = normalized(text);
    const scopeMatch = atom.match(
      new RegExp(`^(?:範囲:?)?(?:\\((${reportingScope})\\)|(${reportingScope}))$`)
    );
    const scope = scopeMatch?.[1] ?? scopeMatch?.[2];
    const basis = atom.match(new RegExp(`^(?:会計基準:?)?(${reportingBasis})$`, 'i'))?.[1];
    if (scope) attributes.push({ role: 'scope', value: scope });
    if (basis) attributes.push({ role: 'basis', value: basis });
  }
  const titles = segments.filter(isReportingCoverTitle);
  const caption = captionText(block);
  if (titles.length) {
    for (const title of titles) {
      for (const match of normalized(title).matchAll(new RegExp(`\\((${reportingScope})\\)`, 'g')))
        attributes.push({ role: 'scope', value: match[1] });
      for (const value of bracketedReportingBases(title)) attributes.push({ role: 'basis', value });
    }
  } else if (headingLevel(block) !== null || (tableCaption && forecastReportingTitle(block.text))) {
    const scope = caption.match(
      new RegExp(
        `^\\(?${reportingScopeHeading}(?:経営成績|業績|財政状態|財務諸表|損益計算書|貸借対照表|キャッシュ.*フロー)`
      )
    )?.[1];
    if (scope) attributes.push({ role: 'scope', value: scope });
  }
  return attributes;
}
/** Every original cell/line must be metadata; a partial projection cannot hide body content. */
export function isReportingMetadata(
  block: Pick<TextBlock, 'id' | 'text'> & Partial<Pick<TextBlock, 'kind'>>
): boolean {
  if (isReportingCover(block)) return false;
  const projection = reportingFieldProjection(block.text);
  return (
    projection.complete &&
    projection.segments.length > 0 &&
    projection.segments.every((text) => {
      const segment = { ...block, text };
      if (isReportingAdministrativeRecord(text)) return true;
      if (reportingValueText(text)) return false;
      if (headingLevel(block) !== null) return false;
      if (declaredSubjectsIn(segment).length > 0) return true;
      const attributes = reportingAttributes(segment);
      return (
        attributes.length > 0 &&
        attributes.every((attribute) =>
          new RegExp(
            `^(?:${attribute.role === 'scope' ? reportingScope : reportingBasis})$`,
            'i'
          ).test(attribute.value)
        )
      );
    })
  );
}

/** A title is leading only when every earlier original record is proved metadata. */
function reportingTitleBoundary(
  block: Pick<TextBlock, 'id' | 'text'>
): { before: string; leading: boolean } | null {
  const text = block.text.normalize('NFKC');
  const title = [...text.matchAll(/[^\n|│]+/g)].find((record) => hasReportingCoverTitle(record[0]));
  if (!title) return null;
  const before = text.slice(0, title.index);
  return {
    before,
    leading: !before.replace(/[\s|│]/g, '') || isReportingMetadata({ ...block, text: before }),
  };
}

/** Cover ownership is a contiguous prefix, never later values or appendix metadata. */
export function reportingCoverBlocks<
  T extends { id: string; text: string; kind?: 'paragraph' | 'row' | 'heading' },
>(blocks: T[]): T[] {
  const cover: T[] = [];
  for (const block of blocks) {
    const source = {
      ...block,
      kind: block.kind === 'heading' ? ('paragraph' as const) : block.kind,
    };
    if (!block.text.trim()) continue;
    const projection = reportingFieldProjection(block.text);
    if (
      !projection.complete ||
      !projection.segments.length ||
      !projection.segments.every((text) => {
        const segment = { ...source, text };
        return isReportingCover(segment) ? !reportingValueText(text) : isReportingMetadata(segment);
      })
    )
      break;
    cover.push(block);
  }
  return cover;
}

/** One identity-shaped wordmark may precede the first complete reporting cover.
 * It supplies no issuer or reporting attributes; arbitrary unknown text is a boundary.
 */
export function reportingDocumentCover<
  T extends { id: string; text: string; kind?: 'paragraph' | 'row' | 'heading' },
>(blocks: T[]): T[] {
  const prefix = reportingCoverBlocks(blocks);
  if (prefix.some(isReportingCover)) return prefix;
  const administrative = (block: T) => {
    const projection = reportingFieldProjection(block.text);
    return (
      projection.complete &&
      projection.segments.length > 0 &&
      projection.segments.every(isReportingAdministrativeRecord) &&
      declaredSubjectsIn(block).length === 0 &&
      reportingAttributes({ id: block.id, text: block.text }).length === 0
    );
  };
  if (!prefix.every(administrative)) return prefix;
  const start = blocks.findIndex((block) => block.text.trim() && !prefix.includes(block));
  if (start < 0) return prefix;
  const mark = blocks[start].text.normalize('NFKC').trim();
  const words = mark.split(/[ \t]*,[ \t]*|[ \t]+/);
  // Generic corporate identity syntax, never a list of supported companies.
  // Commas separate words; a token is a word/abbreviation or dotted initials.
  // Punctuation cannot erase a source record, quantity, or unknown trailing cell.
  // Reference/navigation labels cannot become identity marks by adding a suffix.
  if (
    words.length < 2 ||
    !/^(?:GROUP|HOLDINGS|CORPORATION|INC\.?|LTD\.?)$/.test(words[words.length - 1]) ||
    !words.slice(0, -1).every((word) => /^(?:[A-Z][A-Z&'-]*\.?|(?:[A-Z]\.)+[A-Z]?)$/.test(word)) ||
    /\b(?:REFERENCES?|APPENDIX|APPENDICES|ATTACHMENTS?)\b/.test(mark.replace(/\./g, ''))
  )
    return prefix;
  const before = [...prefix];
  for (let index = start + 1; index < blocks.length; index++) {
    const block = blocks[index];
    if (!block.text.trim()) continue;
    if (reportingTitleBoundary(block)?.leading) {
      const cover = reportingCoverBlocks(blocks.slice(index));
      const namedIssuer = cover.some((item) =>
        reportingFieldSegments(item.text).some(
          (text) =>
            /^(?:上場会社名|会社名|名称)/.test(normalized(text)) &&
            declaredSubjectsIn({ text }).length > 0
        )
      );
      return cover.some(isReportingCover) && namedIssuer ? [...before, ...cover] : prefix;
    }
    if (!administrative(block)) break;
    before.push(block);
  }
  return prefix;
}

/** Semantic context uses the proved title record; evidence IDs/text stay original. */
export function reportingContextText(
  pages: Pick<ExtractedPage, 'blocks' | 'spans'>[],
  ids: string[]
): string {
  if (!ids.length) return '';
  const blocks = pages.flatMap((page) => page.blocks);
  let spans: ExtractedPage['spans'] | undefined;
  const requested = new Set(ids);
  const titles = new Map<string, { id: string; text: string }>();
  for (const block of blocks) {
    if (!requested.has(block.id) && !block.spanIds.every((id) => requested.has(id))) continue;
    if (!hasReportingCoverTitle(block.text)) continue;
    const records = reportingFieldSegments(block.text).filter(isReportingCoverTitle);
    if (!records.length || reportingCoverBlocks([block]).length !== 1) continue;
    const title = { id: block.id, text: records.join('\n') };
    for (const id of [block.id, ...block.spanIds]) titles.set(id, title);
  }
  const seen = new Set<string>();
  return ids
    .flatMap((id) => {
      const title = titles.get(id);
      if (title) {
        if (seen.has(title.id)) return [];
        seen.add(title.id);
        return [title.text];
      }
      const reference =
        blocks.find((block) => block.id === id) ??
        (spans ??= pages.flatMap((page) => page.spans)).find((span) => span.id === id);
      if (!reference) throw new Error(`REFERENCE:原文の文脈 ${id} がありません`);
      return [reference.text];
    })
    .join('\n');
}

function declarations(
  block: TextBlock,
  origin: ContextDeclaration['origin'],
  tableCaption = false
): ContextDeclaration[] {
  const text = normalized(block.text);
  const result: ContextDeclaration[] = declaredSubjectsIn(block).map((value) => ({
    role: 'subject',
    value,
    id: block.id,
    origin,
  }));
  for (const attribute of reportingAttributes(block, tableCaption))
    result.push({
      ...attribute,
      id: block.id,
      origin,
      ...(tableCaption || forecastReportingTitle(block.text) ? { financialOnly: true } : {}),
    });
  for (const field of reportingFieldSegments(block.text)) {
    const stock = normalized(field).match(/^株式種類:?(.+)$/)?.[1];
    if (stock) result.push({ role: 'scope', value: stock, id: block.id, origin });
  }
  const stock = reportingFieldSegments(block.text).find((line) =>
    /取得対象株式.*種類/.test(normalized(line))
  );
  if (stock) {
    const value = normalized(stock).match(/種類(?:[:：])?(.+)$/)?.[1];
    if (value) result.push({ role: 'scope', value, id: block.id, origin: 'local' });
  }
  if (
    block.kind === 'paragraph' &&
    !/^(?:当社|当グループ)/.test(text) &&
    /[0-9][0-9,.]*(?:百万|千|億)?(?:円|株|件|人|%)/.test(text)
  ) {
    const owners = [
      ...text.matchAll(/^((?:株式会社|有限会社|合同会社)[\p{L}\p{N}・&.-]+?)(?:の|は|が)/gu),
      ...text.matchAll(/^([\p{L}\p{N}・&.-]+?(?:株式会社|有限会社|合同会社))(?:の|は|が)/gu),
    ].map((m) => m[1]);
    for (const value of unique(owners))
      result.push({ role: 'subject', value, id: block.id, origin: 'local', selfOnly: true });
  }
  const namedScope = text.match(/(?:MRR|ARR|KPI)[(（]([^()（）]+)[)）]/)?.[1];
  if (namedScope && text.length < 180 && !/[。]/.test(text))
    result.push({ role: 'scope', value: namedScope, id: block.id, origin: 'local' });
  return result.map((d) => ({
    ...d,
    financialOnly:
      d.role !== 'subject' &&
      (/決算短信/.test(text) ||
        isPerformanceReportingTitle(captionText(block)) ||
        !!forecastReportingTitle(captionText(block))),
  }));
}
/** Later explicit fields replace prior fields of that role, retaining same-field ambiguity. */
function replaceFields(
  previous: ContextDeclaration[],
  next: ContextDeclaration[]
): ContextDeclaration[] {
  const roles = new Set(next.map((d) => d.role));
  return [...previous.filter((d) => !roles.has(d.role)), ...next];
}
export function buildDocumentContext(pages: ExtractedPage[]): DocumentContext {
  const first = pages.find((p) => p.pageNumber === 1);
  const cover: TextBlock[] = [];
  const firstBlocks = first?.blocks ?? [];
  const prefix = reportingDocumentCover(firstBlocks);
  const boundary = firstBlocks.find((block) => block.text.trim() && !prefix.includes(block));
  // Only a title in the contiguous leading records owns this document. A
  // malformed title at that boundary remains strict; later references cannot
  // retroactively replace an ordinary notice's issuer prefix with an empty one.
  const earningsCover =
    prefix.some(isReportingCover) || !!(boundary && reportingTitleBoundary(boundary)?.leading);
  if (earningsCover) cover.push(...prefix);
  else {
    // Non-earnings disclosures retain their supported title/issuer ordering.
    let issuerSeen = false;
    for (const block of firstBlocks) {
      const title = reportingTitleBoundary(block);
      if (title?.leading) break;
      if (
        headingLevel(block) !== null &&
        (issuerSeen || /^(?:\(\d+\)|\d+[.．]|■|\(?[①-⑳]\)?)/.test(normalized(block.text)))
      )
        break;
      cover.push(block);
      if (title) break;
      if (declaredSubjectsIn(block).length) issuerSeen = true;
    }
  }
  const issuerSource = (block: TextBlock): TextBlock => {
    const title = !earningsCover && reportingTitleBoundary(block);
    if (!title) return block;
    return {
      ...block,
      // An ordinary notice can share a physical block with its reference.
      text: title.before,
    };
  };
  const issuer = cover.filter(
    (b) =>
      /^(?:会社名|上場会社名)/.test(normalized(issuerSource(b).text)) ||
      declaredSubjectsIn(issuerSource(b)).length > 0
  );
  // A cover consisting of one standalone company name is also a declaration.
  const namedIssuer = issuer.filter((b) =>
    /^(?:上場会社名|会社名|名称)/.test(normalized(issuerSource(b).text))
  );
  const issuerBlocks = namedIssuer.length ? namedIssuer : issuer.length === 1 ? issuer : [];
  const reporting = earningsCover ? cover.filter(isReportingCover) : [];
  const documentDeclarations = [...issuerBlocks, ...reporting].flatMap((b) =>
    declarations(issuerSource(b), 'document')
  );
  const links = noteLinks(pages),
    localNotes = paragraphNoteLinks(pages);
  const bindings: ContextBinding[] = [];
  const tableMappings = buildTableMappings(pages);
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const hints = tableMappings.filter((h) => page.quantities.some((q) => q.id === h.valueId));
    const firstHeading = page.blocks.find((b) => headingLevel(b) !== null);
    const pageFields = page.blocks.filter(
      (b) =>
        (!firstHeading || b.y < firstHeading.y) &&
        /^(?:上場会社名|会社名|名称)/.test(normalized(b.text)) &&
        !issuerBlocks.includes(b)
    );
    // A lone page field declares the page owner. Multiple fields without a
    // heading are sequential units, resolved as they are encountered.
    const pageDeclarations = (!firstHeading && pageFields.length > 1 ? [] : pageFields).reduce<
      ContextDeclaration[]
    >((previous, b) => replaceFields(previous, declarations(b, 'local')), []);
    const stack: TextBlock[] = [];
    const fieldScopes = new Map<string | null, ContextDeclaration[]>();
    for (const block of page.blocks) {
      const level = headingLevel(block);
      if (level !== null) {
        while (stack.length && (headingLevel(stack[stack.length - 1]) ?? Infinity) >= level)
          fieldScopes.delete(stack.pop()!.id);
        stack.push(block);
      }
      if (
        declarations(block, 'local').length &&
        !reporting.includes(block) &&
        !issuerBlocks.includes(block) &&
        !stack.includes(block)
      ) {
        const next = declarations(block, 'local').filter((d) => !d.selfOnly);
        const owner = stack[stack.length - 1]?.id ?? null;
        fieldScopes.set(owner, replaceFields(fieldScopes.get(owner) ?? [], next));
      }
      const fields = [null, ...stack.map((b) => b.id)].reduce<ContextDeclaration[]>(
        (previous, owner) => replaceFields(previous, fieldScopes.get(owner) ?? []),
        []
      );
      const anchors = [
        block.id,
        ...page.quantities.filter((q) => block.spanIds.includes(q.id)).map((q) => q.id),
      ];
      for (const anchorId of anchors) {
        const table = anchorId !== block.id;
        const continued = table ? continuationFor(pages, page, anchorId) : undefined;
        const sectionBlocks = stack.filter((b) => b.id !== block.id);
        const ownDeclarations = [
          ...pageDeclarations.filter((d) => !fields.some((f) => f.role === d.role)),
          ...fields,
          ...[...sectionBlocks, block].flatMap((b) =>
            declarations(b, 'local').filter((d) => !d.selfOnly || b === block)
          ),
        ];
        if (continued) {
          for (const id of continued.scopeIds) {
            const owner = pages.flatMap((p) => p.blocks).find((b) => b.id === id)!;
            // A company overview title may name its subject instead of a company field.
            const name = normalized(owner.text).match(
              /((?:株式会社|有限会社)[\p{L}\p{N}・&.-]+)(?:の概要|概要)/u
            )?.[1];
            if (name) ownDeclarations.push({ role: 'subject', value: name, id, origin: 'local' });
            ownDeclarations.push(...declarations(owner, 'local'));
          }
        }
        const semanticSections = sectionBlocks.filter((b) =>
          /経営成績|業績予想|財政状態|損益計算書|貸借対照表|配当|今後の見通し|20\d{2}年/.test(
            b.text
          )
        );
        const hint = table ? hints.find((h) => h.valueId === anchorId) : undefined;
        const regions = page.tableRegions.filter((r) => r.valueIds.includes(anchorId));
        if (hint && regions.length === 1) {
          const caption = page.blocks.find(
            (b) =>
              forecastReportingTitle(b.text) &&
              b.spanIds.every((id) => hint.contextIds.includes(id)) &&
              b.spanIds.every((id) => regions[0].spanIds.includes(id))
          );
          if (caption) ownDeclarations.push(...declarations(caption, 'local', true));
        }
        const contexts =
          continued?.contextIds ??
          hint?.contextIds ??
          semanticSections.slice(-1).flatMap((b) => (table ? b.spanIds : [b.id]));
        const qualifiers = unique([
          ...localNotes.filter((l) => l.blockId === block.id).map((l) => l.noteId),
          ...(hint
            ? splitNotes(continuationPage(pages, page, anchorId), anchorId)
                .filter((note) => {
                  const metric = normalized(
                    hint.metricIds
                      .map((id) => pages.flatMap((p) => p.spans).find((s) => s.id === id)!.text)
                      .join('')
                  );
                  const axis = normalized(
                    hint.periodIds
                      .map((id) => pages.flatMap((p) => p.spans).find((s) => s.id === id)!.text)
                      .join('')
                  );
                  const inherited = normalized(reportingContextText(pages, contexts));
                  const years = [
                    ...new Set(
                      axis.match(/20\d{2}年\d{1,2}月期/g) ??
                        inherited.match(/20\d{2}年\d{1,2}月期/g) ??
                        []
                    ),
                  ];
                  const shape =
                    reportingPeriodOwner(axis, inherited, true).match(
                      /第[1-4]四半期(?:累計|単独)?|中間期|通期/
                    )?.[0] ?? '';
                  return splitNoteApplies(
                    note.text,
                    metric,
                    years.length === 1 ? years[0] + shape : null,
                    numericValueKind(axis, inherited)
                  );
                })
                .map((note) => note.id)
            : []),
        ]);
        const binding: ContextBinding = {
          id: `ctx:${anchorId}`,
          page: page.pageNumber,
          anchorId,
          blockId: block.id,
          sectionIds: sectionBlocks.map((b) => b.id),
          contextIds: unique(contexts),
          declarations: [...documentDeclarations, ...ownDeclarations],
          qualifierIds: qualifiers,
          requiredPages: [],
        };
        // A proved cover value may reference the explicit report period. This
        // never crosses the contiguous cover boundary or supplies a default.
        if (!table && block.kind === 'paragraph' && isReportingCoverUnit(binding, pages)) {
          const cover = reporting.filter((b) => b.y < block.y).slice(-1)[0];
          if (cover) binding.contextIds = unique([...binding.contextIds, cover.id]);
        }
        // Preserve stock types and acquisition dates/method within the current
        // transaction section. A later unrelated section cannot supply them.
        if (!table && /取得する株式|株式の取得価額/.test(block.text)) {
          const before = page.blocks.filter((b) => b.y < block.y);
          const method = [...before]
            .reverse()
            .find((b) => /取得の方法|買付けの委託/.test(normalized(b.text)));
          const stock = [...before]
            .reverse()
            .find((b) => /取得対象株式.*種類/.test(normalized(b.text)));
          const boundary = sectionBlocks[sectionBlocks.length - 1];
          if (
            method &&
            boundary &&
            /取得の内容/.test(normalized(boundary.text)) &&
            before.some((b) => /取得の方法/.test(normalized(b.text)) && b.y < method.y)
          )
            binding.contextIds.push(method.id);
          if (stock && (!boundary || stock.y >= boundary.y))
            binding.declarations.push(...declarations(stock, 'local'));
        }
        const pageIds = [
          ...binding.contextIds,
          ...binding.declarations.map((d) => d.id),
          ...qualifiers,
        ];
        binding.requiredPages = unique([
          page.pageNumber,
          ...pageIds.map((id) => Number(id.match(/^p(\d+)/)![1])),
        ]);
        bindings.push(binding);
      }
    }
  }
  // Cross-page named-series notes carry both the note and its business caption.
  for (const binding of bindings)
    for (const link of links.filter((l) => l.fromPage === binding.page)) {
      const block = pages
        .find((p) => p.pageNumber === binding.page)!
        .blocks.find((b) => b.id === link.headingId)!;
      const anchor = pages
        .find((p) => p.pageNumber === binding.page)!
        .blocks.find((b) => b.id === binding.blockId)!;
      const mapping = tableMappings.filter((h) => h.valueId === binding.anchorId);
      const metric =
        mapping.length === 1
          ? mapping[0].metricIds
              .map((id) => pages.flatMap((p) => p.spans).find((s) => s.id === id)!.text)
              .join('')
          : '';
      if (block.y <= anchor.y && normalized(metric) === normalized(link.metric)) {
        binding.declarations.push(...declarations(block, 'local'));
        binding.qualifierIds.push(link.noteId);
        if (!binding.contextIds.length) binding.contextIds.push(...block.spanIds);
        binding.requiredPages = unique([
          ...binding.requiredPages,
          Number(link.noteId.match(/^p(\d+)/)![1]),
        ]);
      }
    }
  return { bindings, tableMappings };
}
/** Document subject is resolved from the same cover declarations as validation. */
export function documentSubject(context: DocumentContext): string | null {
  const values = unique(
    context.bindings.flatMap((b) =>
      b.declarations
        .filter((d) => d.origin === 'document' && d.role === 'subject')
        .map((d) => normalized(d.value))
    )
  );
  return values.length === 1 ? values[0] : null;
}
export function bindingFor(context: DocumentContext, anchorId: string): ContextBinding {
  const binding = context.bindings.find((b) => b.anchorId === anchorId);
  if (!binding) throw new Error(`REFERENCE:原文単位 ${anchorId} がありません`);
  return binding;
}
/** Resolve role ownership before matching the model's proposed value. */
export function applicableDeclarations(
  binding: ContextBinding,
  role: DeclarationRole,
  financial: boolean
): ContextDeclaration[] {
  const localSubject = binding.declarations.filter(
    (d) => d.role === 'subject' && d.origin === 'local'
  );
  const issuer = binding.declarations.filter(
    (d) => d.role === 'subject' && d.origin === 'document'
  );
  const otherOwner = localSubject.some(
    (d) => !issuer.some((i) => normalized(i.value) === normalized(d.value))
  );
  const candidates = binding.declarations.filter(
    (d) =>
      d.role === role &&
      !(role !== 'subject' && otherOwner && d.origin === 'document') &&
      (!d.financialOnly || financial)
  );
  const local = candidates.filter((d) => d.origin === 'local');
  return local.length ? local : candidates;
}
export function resolveScopeIds(
  binding: ContextBinding,
  meaning: Pick<FactSemantics, 'subject' | 'scope' | 'basis'>,
  financial: boolean,
  roles: DeclarationRole[] = ['subject', 'scope', 'basis']
): string[] {
  const ids: string[] = [];
  for (const role of roles) {
    const ds = applicableDeclarations(binding, role, financial);
    const values = unique(ds.map((d) => reportingAttributeKey(role, d.value)));
    if (values.length > 1) throw new Error(`SCOPE:適用する${role}が曖昧です: ${values.join('/')}`);
    const value = meaning[role];
    if (value === null) {
      if (values.length)
        throw new Error(`SCOPE:${role}の明示根拠があるのに意味属性が欠落しています`);
      continue;
    }
    if (!values.includes(reportingAttributeKey(role, value)))
      throw new Error(`SCOPE:${role}の適用根拠が不一致です。適用候補=${values.join('/')}`);
    ids.push(
      ...binding.declarations
        .filter(
          (d) =>
            d.role === role &&
            reportingAttributeKey(role, d.value) === reportingAttributeKey(role, value)
        )
        .map((d) => d.id)
    );
  }
  return unique(ids);
}
/** Reporting role ownership is separate from local scope/basis ownership. */
export function reportingUnitTitle(binding: ContextBinding, pages: ExtractedPage[]): string {
  const blocks = pages.flatMap((p) => p.blocks);
  const section = binding.sectionIds
    .slice(-1)
    .map((id) => blocks.find((b) => b.id === id)!.text)
    .join('');
  // A table's separate period header qualifies its own financial caption.
  // Arbitrary child business sections still own their role and cannot borrow it.
  const page = pages.find((p) => p.pageNumber === binding.page);
  const tables = page?.tableRegions.filter((t) => t.valueIds.includes(binding.anchorId)) ?? [];
  if (tables.length === 1 && (!section || forecastPeriodDeclaration(section))) {
    const caption = page!.blocks.find(
      (b) =>
        forecastReportingTitle(b.text) &&
        b.spanIds.every((id) => binding.contextIds.includes(id)) &&
        b.spanIds.every((id) => tables[0].spanIds.includes(id))
    );
    if (
      caption &&
      (!section ||
        forecastTablePeriodSources(caption, page!.blocks, page!.spans, tables[0]).some(
          (b) => normalized(b.text) === normalized(section)
        ))
    )
      return normalized(caption.text);
  }
  return normalized(section || reportingContextText(pages, binding.contextIds));
}
export function isReportingCoverUnit(binding: ContextBinding, pages: ExtractedPage[]): boolean {
  return inReportingCover(binding, pages, true);
}
/** Explicit fields before the first value or section belong to the cover. */
export function isReportingCoverField(binding: ContextBinding, pages: ExtractedPage[]): boolean {
  return inReportingCover(binding, pages, false);
}
function inReportingCover(
  binding: ContextBinding,
  pages: ExtractedPage[],
  requireValue: boolean
): boolean {
  if (binding.page !== 1 || binding.sectionIds.length) return false;
  const blocks = pages.find((p) => p.pageNumber === 1)?.blocks ?? [];
  if (!requireValue) {
    const cover = reportingDocumentCover(blocks);
    const target = cover.findIndex((block) => block.id === binding.blockId);
    return target >= 0 && cover.slice(0, target).some(isReportingCover);
  }
  const target = blocks.findIndex((b) => b.id === binding.blockId);
  let cover = -1;
  for (const block of reportingDocumentCover(blocks.slice(0, target)))
    if (isReportingCover(block)) cover = blocks.indexOf(block);
  if (cover < 0) return false;
  // Only a contiguous reporting-value area belongs to this cover. Unknown prose
  // or an unnumbered caption closes it; later values cannot reopen it.
  const metric = `(?:売上高営業利益率|売上高|売上収益|営業収益|営業(?:利益|損失)|経常(?:利益|損失)|${NET_PROFIT_METRIC}|総資産|純資産|資本金)`;
  const valueStart = new RegExp(
    `^(?:20\\d{2}年\\d{1,2}月期(?:第[1-4]四半期|中間期|通期)?(?:の)?)?${metric}(?:は|:)?[△▲−-]?\\d`
  );
  let valuesStarted = false;
  for (let i = cover + 1; i <= target; i++) {
    const block = blocks[i];
    if (valueStart.test(normalized(block.text))) valuesStarted = true;
    else if (valuesStarted || !isReportingMetadata(block)) return false;
    if (i === target)
      return requireValue
        ? valuesStarted && valueStart.test(normalized(block.text))
        : !valuesStarted;
  }
  return false;
}
export function isFinancialUnit(
  fact: Pick<VerifiedFact, 'kind' | 'label' | 'quote' | 'semantics'>,
  binding: ContextBinding,
  pages: ExtractedPage[]
): boolean {
  if (/配当/.test(fact.label) && fact.semantics.metricKind === 'perShare') return false;
  const titles = binding.sectionIds
    .map((id) => pages.flatMap((p) => p.blocks).find((b) => b.id === id)?.text ?? '')
    .join('\n');
  return (
    isPerformanceReportingTitle(titles + reportingUnitTitle(binding, pages)) ||
    binding.sectionIds.some((id) =>
      forecastReportingTitle(pages.flatMap((p) => p.blocks).find((b) => b.id === id)?.text ?? '')
    ) ||
    !!forecastReportingTitle(reportingUnitTitle(binding, pages)) ||
    /財政状態|貸借対照表|キャッシュ.*フロー/.test(titles + reportingUnitTitle(binding, pages)) ||
    (isReportingCoverUnit(binding, pages) &&
      new RegExp(
        `売上高|売上収益|営業収益|営業利益|営業損失|経常利益|経常損失|${NET_PROFIT_METRIC}|総資産|純資産|資本金|キャッシュ.*フロー`
      ).test(normalized(fact.label))) ||
    /連結財務諸表|純損失|特別損失/.test(fact.quote)
  );
}

/** Use role ownership for both confirmed facts and coverage, including evidence references. */
export function verifyScopeEvidence(
  binding: ContextBinding,
  meaning: Pick<FactSemantics, 'subject' | 'scope' | 'basis'>,
  financial: boolean,
  scopeIds: string[]
): void {
  const required = resolveScopeIds(binding, meaning, financial);
  if (
    scopeIds.some((id) => !required.includes(id)) ||
    (['subject', 'scope', 'basis'] as const).some(
      (role) =>
        meaning[role] !== null &&
        !binding.declarations.some(
          (d) =>
            d.role === role &&
            reportingAttributeKey(role, d.value) === reportingAttributeKey(role, meaning[role]!) &&
            scopeIds.includes(d.id)
        )
    )
  )
    throw new Error(`SCOPE:役割に適用するscopeIdsが不一致です。必要=${JSON.stringify(required)}`);
}
