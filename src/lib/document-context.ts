import type { ExtractedPage } from '@/types/summaryMetadata';
import type { FactSemantics, VerifiedFact } from './fact-contract';
import { normalized, type TextBlock } from './document-structure';
import { buildTableMappings, type TableMapping } from './source-mappings';
import { continuationFor, noteLinks, paragraphNoteLinks } from './document-links';

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
const reportingScope = '非連結|個別|単体|連結';
const reportingBasis = '日本基準|IFRS|国際会計基準|米国基準';
export function declaredSubjectsIn(block: TextBlock): string[] {
  return unique(
    block.text.split('\n').flatMap((line) => {
      const text = normalized(line).replace(/^(?:\(\d+\)|\d+[.．])/, '');
      const field = text.match(/^(?:上場会社名|会社名|名称)(.+)$/)?.[1];
      if (field) return [field.split(/[|｜]|上場取引所|コード番号|URL|代表者名/)[0]];
      return /^(?:株式会社|有限会社|合同会社|投資法人)[\p{L}\p{N}・&.-]+$|^[\p{L}\p{N}・&.-]+(?:株式会社|有限会社|合同会社|投資法人)$/u.test(
        text
      )
        ? [text]
        : [];
    })
  ).filter(Boolean);
}
/** A numbered title is a boundary, not every body mention of a scope/period. */
export function headingLevel(block: TextBlock): number | null {
  const text = normalized(block.text);
  if (text.length > 180 || /[。；]|\d[\d,]*株|\d[\d,]*円/.test(text)) return null;
  if (/^■/.test(text)) return 1;
  if (/^20\d{2}年.*(?:経営成績|予想|配当|月度|実績|取得予定)/.test(text)) return 3;
  if (/^\d+[.．]/.test(text)) return 1;
  if (/^\(\d+\)/.test(text)) return 2;
  if (/^\(?[①-⑳]\)?/.test(text)) return 3;
  if (
    /^\((?:連結|個別)?(?:損益計算書|貸借対照表|キャッシュ.*|重要な.*|追加情報|.*関係)\)$/.test(text)
  )
    return 3;
  return null;
}
function captionText(block: TextBlock): string {
  return normalized(block.text)
    .replace(/^(?:\(\d+\)|\d+[.．]|■)/, '')
    .replace(/^20\d{2}年\d{1,2}月期(?:(?:第[1-4]四半期|中間期|通期)|\(中間期\))*(?:の)?/, '')
    .replace(/^(?:[1-4]Q|第[1-4]四半期(?:\(中間期\))?)(?=決算短信)/i, '');
}
function isReportingCover(block: TextBlock): boolean {
  return /^(?:四半期|中間)?決算短信/.test(captionText(block));
}
/** A role field supplies its entire value; a caption needs an explicit reporting object. */
function reportingAttributes(block: TextBlock): { role: 'scope' | 'basis'; value: string }[] {
  const attributes: { role: 'scope' | 'basis'; value: string }[] = [];
  for (const part of block.text.normalize('NFKC').split(/[\n|]/)) {
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
  const caption = captionText(block);
  if (isReportingCover(block)) {
    for (const match of caption.matchAll(new RegExp(`\\((${reportingScope})\\)`, 'g')))
      attributes.push({ role: 'scope', value: match[1] });
    for (const match of caption.matchAll(
      new RegExp(`〔(${reportingBasis})〕|\\[(${reportingBasis})\\]`, 'gi')
    ))
      attributes.push({ role: 'basis', value: match[1] ?? match[2] });
  } else if (headingLevel(block) !== null) {
    const scope = caption.match(
      new RegExp(
        `^\\(?(${reportingScope})(?:累計期間)?(?:の)?(?:経営成績|業績|財政状態|財務諸表|損益計算書|貸借対照表|キャッシュ.*フロー)`
      )
    )?.[1];
    if (scope) attributes.push({ role: 'scope', value: scope });
  }
  return attributes;
}
function declarations(
  block: TextBlock,
  origin: ContextDeclaration['origin']
): ContextDeclaration[] {
  const text = normalized(block.text);
  const result: ContextDeclaration[] = declaredSubjectsIn(block).map((value) => ({
    role: 'subject',
    value,
    id: block.id,
    origin,
  }));
  for (const attribute of reportingAttributes(block))
    result.push({ ...attribute, id: block.id, origin });
  const fieldStock = text.match(/株式種類([^|｜]+)/)?.[1];
  if (fieldStock) result.push({ role: 'scope', value: fieldStock, id: block.id, origin });
  const stock = block.text.split('\n').find((line) => /取得対象株式.*種類/.test(normalized(line)));
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
    financialOnly: origin === 'document' && /決算短信/.test(text) && d.role !== 'subject',
  }));
}
export function buildDocumentContext(pages: ExtractedPage[]): DocumentContext {
  const first = pages.find((p) => p.pageNumber === 1);
  const issuer =
    first?.blocks.filter(
      (b) => /^(?:会社名|上場会社名)/.test(normalized(b.text)) || declaredSubjectsIn(b).length > 0
    ) ?? [];
  // A cover consisting of one standalone company name is also a declaration.
  const namedIssuer = issuer.filter((b) => /会社名/.test(normalized(b.text)));
  const issuerBlocks = namedIssuer.length ? namedIssuer : issuer.length === 1 ? issuer : [];
  const reporting = first?.blocks.filter((b) => isReportingCover(b) && b.text.length < 180) ?? [];
  const documentDeclarations = [...issuerBlocks, ...reporting].flatMap((b) =>
    declarations(b, 'document')
  );
  const links = noteLinks(pages),
    localNotes = paragraphNoteLinks(pages);
  const bindings: ContextBinding[] = [];
  const tableMappings = buildTableMappings(pages);
  for (const page of [...pages].sort((a, b) => a.pageNumber - b.pageNumber)) {
    const hints = tableMappings.filter((h) => page.quantities.some((q) => q.id === h.valueId));
    const firstHeading = page.blocks.find((b) => headingLevel(b) !== null);
    const pageDeclarations = page.blocks
      .filter(
        (b) =>
          (!firstHeading || b.y < firstHeading.y) &&
          /^(?:上場会社名|会社名)/.test(normalized(b.text)) &&
          !issuerBlocks.includes(b)
      )
      .flatMap((b) => declarations(b, 'local'));
    const stack: TextBlock[] = [];
    let fields: TextBlock[] = [];
    for (const block of page.blocks) {
      const level = headingLevel(block);
      if (level !== null) {
        while (stack.length && (headingLevel(stack[stack.length - 1]) ?? Infinity) >= level)
          stack.pop();
        stack.push(block);
        fields = [];
      }
      if (
        declarations(block, 'local').length &&
        !reporting.includes(block) &&
        !issuerBlocks.includes(block) &&
        !stack.includes(block)
      )
        fields.push(block);
      const anchors = [
        block.id,
        ...page.quantities.filter((q) => block.spanIds.includes(q.id)).map((q) => q.id),
      ];
      for (const anchorId of anchors) {
        const table = anchorId !== block.id;
        const continued = table ? continuationFor(pages, page, anchorId) : undefined;
        const sectionBlocks = stack.filter((b) => b.id !== block.id);
        const ownDeclarations = [
          ...pageDeclarations,
          ...[...sectionBlocks, ...fields, block].flatMap((b) =>
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
        const contexts =
          continued?.contextIds ??
          hint?.contextIds ??
          semanticSections.slice(-1).flatMap((b) => (table ? b.spanIds : [b.id]));
        const qualifiers = unique(
          localNotes.filter((l) => l.blockId === block.id).map((l) => l.noteId)
        );
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
      (d.origin === 'local' || !d.financialOnly || financial)
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
    const values = unique(ds.map((d) => normalized(d.value)));
    if (values.length > 1) throw new Error(`SCOPE:適用する${role}が曖昧です: ${values.join('/')}`);
    const value = meaning[role];
    if (value === null) {
      if (values.length)
        throw new Error(`SCOPE:${role}の明示根拠があるのに意味属性が欠落しています`);
      continue;
    }
    if (!values.includes(normalized(value)))
      throw new Error(`SCOPE:${role}の適用根拠が不一致です。適用候補=${values.join('/')}`);
    ids.push(
      ...binding.declarations
        .filter((d) => d.role === role && normalized(d.value) === normalized(value))
        .map((d) => d.id)
    );
  }
  return unique(ids);
}
/** Reporting role ownership is separate from local scope/basis ownership. */
export function reportingUnitTitle(binding: ContextBinding, pages: ExtractedPage[]): string {
  const blocks = pages.flatMap((p) => p.blocks);
  const spans = pages.flatMap((p) => p.spans);
  const section = binding.sectionIds
    .slice(-1)
    .map((id) => blocks.find((b) => b.id === id)!.text)
    .join('');
  return normalized(
    section ||
      binding.contextIds
        .map(
          (id) =>
            blocks.find((b) => b.id === id)?.text ?? spans.find((s) => s.id === id)?.text ?? ''
        )
        .join('')
  );
}
export function isReportingCoverUnit(binding: ContextBinding, pages: ExtractedPage[]): boolean {
  if (binding.page !== 1 || binding.sectionIds.length) return false;
  const blocks = pages.find((p) => p.pageNumber === 1)?.blocks ?? [];
  const target = blocks.findIndex((b) => b.id === binding.blockId);
  let cover = -1;
  for (let i = 0; i < target; i++)
    if (blocks[i].text.length < 180 && isReportingCover(blocks[i])) cover = i;
  if (cover < 0) return false;
  // Only a contiguous reporting-value area belongs to this cover. Unknown prose
  // or an unnumbered caption closes it; later values cannot reopen it.
  const metric =
    '(?:売上高|売上収益|営業収益|営業(?:利益|損失)|経常(?:利益|損失)|(?:親会社株主に帰属する|親会社の所有者に帰属する)?(?:当期|中間|四半期)純(?:利益|損失)|総資産|純資産|資本金)';
  const valueStart = new RegExp(
    `^(?:20\\d{2}年\\d{1,2}月期(?:第[1-4]四半期|中間期|通期)?(?:の)?)?${metric}(?:は|:)?[+\\-△]?\\d`
  );
  let valuesStarted = false;
  for (let i = cover + 1; i <= target; i++) {
    const block = blocks[i];
    const attributes = reportingAttributes(block);
    if (valueStart.test(normalized(block.text))) valuesStarted = true;
    else if (
      valuesStarted ||
      !(
        declaredSubjectsIn(block).length ||
        (attributes.length &&
          attributes.every((d) =>
            new RegExp(`^(?:${reportingScope}|${reportingBasis})$`, 'i').test(d.value)
          ))
      )
    )
      return false;
    if (i === target) return valuesStarted && valueStart.test(normalized(block.text));
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
    /経営成績|業績予想|今後の見通し|財政状態|損益計算書|貸借対照表|キャッシュ.*フロー/.test(
      titles + reportingUnitTitle(binding, pages)
    ) ||
    (isReportingCoverUnit(binding, pages) &&
      /売上高|売上収益|営業収益|営業利益|営業損失|経常利益|経常損失|(?:当期|中間|四半期).*純(?:利益|損失)|総資産|純資産|資本金|キャッシュ.*フロー/.test(
        normalized(fact.label)
      )) ||
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
            normalized(d.value) === normalized(meaning[role]!) &&
            scopeIds.includes(d.id)
        )
    )
  )
    throw new Error(`SCOPE:役割に適用するscopeIdsが不一致です。必要=${JSON.stringify(required)}`);
}
