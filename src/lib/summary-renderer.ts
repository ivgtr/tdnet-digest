import {
  canonicalJSON,
  FACT_SCHEMA_VERSION,
  type FactSummary,
  type VerifiedFact,
} from './fact-contract';
import { validatePresentation, type SummaryPresentation } from './summary-presentation';
import type { SourceExcerpt } from './summary-source-inventory';
import { renderNarrativeText } from './summary-narrative-renderer';
import {
  supportedExplanations,
  supportedTables,
  unresolvedExplanationSources,
  unresolvedTableSources,
} from './summary-organization';
import { quantityChange } from './summary-narrative-renderer';
import { reportingMetricKey } from './metric-semantics';
import type { NarrativeTable } from './summary-narrative';
import { sectionPolicies } from './summary-content-policy';
import { unchangedForecastTopic } from './forecast-revision-semantics';
import {
  summaryComparison,
  comparisonLabel,
  comparisonIssue,
  comparisonGrowth,
  type SummaryComparison,
} from './summary-comparison';

export const stateLabels = {
  actual: '実績',
  forecast: '予想',
  forecastBefore: '修正前予想',
  forecastAfter: '修正後予想',
  planned: '実施予定',
  decided: '決議・決定',
  contracted: '契約',
  completed: '実施済み',
  unspecified: '状態未特定',
};
export const literalMarkdown = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~.:/@-]/g, '\\$&')
    .replace(/\n/g, ' ');
const ref = (page: number) => `[p.${page}](tdnet-page:${page})`;
const references = (pages: number[]) =>
  [...new Set(pages)]
    .sort((a, b) => a - b)
    .map(ref)
    .join('・');
const numeric = (f: VerifiedFact) => f.kind === 'number' || f.kind === 'range';
const periodText = (f: VerifiedFact) =>
  f.period && f.semantics.periodKind.startsWith('cumulativeQ') && !/累計|中間期/.test(f.period)
    ? `${f.period}累計`
    : f.period && f.semantics.periodKind.startsWith('standaloneQ') && !/単独/.test(f.period)
      ? `${f.period}単独`
      : f.period;
const decimalText = (text: string) =>
  text.replace(
    /^(-?)(\d+)/,
    (_, sign: string, digits: string) => sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  );
const numberText = (f: VerifiedFact, unit = true) =>
  literalMarkdown(
    (f.quantity!.decimal !== null
      ? decimalText(f.quantity!.decimal)
      : 'lower' in f.quantity!
        ? `${decimalText(f.quantity!.lower)}～${decimalText(f.quantity!.upper)}`
        : '') + (unit ? f.unit : '')
  );
function statementText(f: VerifiedFact): string {
  const topic = unchangedForecastTopic(f.statement!);
  if (topic) return `${topic}：変更なし`;
  const source = f.statement!.normalize('NFKC').replace(/\s/g, '');
  const unchanged = source.match(
    /^\(?注\)?直近に公表されている(配当予想|業績予想)からの修正の有無[:：]?(無|有)$/
  );
  return literalMarkdown(
    unchanged ? `${unchanged[1]}：${unchanged[2] === '無' ? '変更なし' : '修正あり'}` : f.statement!
  );
}
function context(
  f: VerifiedFact,
  shared: { scope: string | null; basis: string | null },
  includePeriod: boolean,
  subjects: boolean
): string {
  return [
    includePeriod ? periodText(f) : null,
    subjects ? f.semantics.subject : null,
    f.semantics.scope !== shared.scope ? f.semantics.scope : null,
    f.semantics.basis !== shared.basis ? f.semantics.basis : null,
    numeric(f) && f.semantics.state !== 'unspecified' && includePeriod
      ? stateLabels[f.semantics.state]
      : null,
  ]
    .filter(Boolean)
    .map((s) => literalMarkdown(s!))
    .join('／');
}
function canPair(amount: VerifiedFact, rate: VerifiedFact): boolean {
  if (
    rate.semantics.metricKind !== 'rate' ||
    amount.semantics.metricKind === 'rate' ||
    amount.label !== rate.label ||
    amount.evidence.kind !== 'table' ||
    rate.evidence.kind !== 'table'
  )
    return false;
  const key = (f: VerifiedFact) =>
    canonicalJSON([
      f.period,
      f.valueKind,
      f.semantics.subject,
      f.semantics.scope,
      f.semantics.basis,
      f.evidence.kind === 'table'
        ? [f.evidence.metricIds, f.evidence.periodIds, f.evidence.contextIds]
        : null,
      f.provenance?.tableId,
      f.semantics.qualifiers,
      f.semantics.conditions,
      f.provenance?.adjustments,
    ]);
  return key(amount) === key(rate);
}
function overviewGrowth(f: VerifiedFact, comparison: SummaryComparison, facts: FactSummary) {
  const growth = comparisonGrowth(f, comparison);
  const rates = facts.facts.filter((r) => canPair(f, r));
  const rate = rates.length === 1 ? rates[0] : undefined;
  if (growth?.kind === 'change' && rate)
    return { text: `（原文 ${rate.quantity!.raw}${rate.unit}）`, calculated: false };
  if (growth?.kind === 'zeroBase')
    return {
      text: `（${f.semantics.periodKind === 'fullYear' ? '前期' : '前年同期'}0のため比率なし）`,
      calculated: false,
    };
  return {
    text: growth ? ` 約${growth.rate}` : '',
    calculated: growth !== null,
  };
}
function overviewNumber(
  f: VerifiedFact,
  facts: FactSummary,
  _presentation: SummaryPresentation
): string {
  const comparison = summaryComparison(f, facts.facts);
  if (comparison) {
    const before = comparison.reference;
    const values =
      comparison.axis === 'revision'
        ? `${numberText(before)} → ${numberText(f)}`
        : `${numberText(f)}（${f.semantics.periodKind === 'fullYear' ? '前期' : '前年同期'} ${numberText(before)}）`;
    const percent = overviewGrowth(f, comparison, facts).text;
    const rate = facts.facts.find((r) => canPair(f, r));
    return `${literalMarkdown(f.label)}：**${comparisonLabel(f, comparison)}${literalMarkdown(percent)}** ${values}${comparison.axis === 'revision' && rate ? `（原文の増減率 ${numberText(rate)}）` : ''}`;
  }
  const rate = facts.facts.find((r) => canPair(f, r));
  if (rate) return `${literalMarkdown(f.label)}：${numberText(f)}（比率 ${numberText(rate)}）`;
  return `${literalMarkdown(f.label)}：${numberText(f)}${f.semantics.state === 'actual' || f.semantics.state === 'forecastAfter' ? `（${comparisonIssue(f, facts.facts)}）` : ''}`;
}
function overviewStatement(f: VerifiedFact, facts: FactSummary): string {
  const text = statementText(f);
  if (text === '業績予想：修正あり') {
    const compared = facts.facts.some(
      (value) => summaryComparison(value, facts.facts)?.axis === 'revision'
    );
    return `業績予想：**修正あり**${compared ? '' : '（修正前の数値・方向は本資料では未確認）'}`;
  }
  if (!/^(?:配当予想|業績予想)：変更なし$/.test(text)) return text;
  const forecasts = facts.facts.filter(
    (value) => numeric(value) && value.valueKind?.startsWith('forecast')
  );
  const periods = [...new Set(forecasts.map((value) => value.period).filter(Boolean))];
  if (periods.length !== 1) return text;
  const annual = forecasts.filter((value) => /配当.*(?:合計|年間)$|年間配当金$/.test(value.label));
  return `${literalMarkdown(periods[0]!)} ${text}${/配当/.test(f.statement!) && annual.length === 1 ? `（年間${numberText(annual[0])}）` : ''}`;
}
function renderExcerpts(excerpts: SourceExcerpt[]): string[] {
  const lines: string[] = [];
  let paragraph: string[] = [];
  let previous: SourceExcerpt | undefined;
  const flush = () => {
    if (paragraph.length) lines.push('', paragraph.join(' '));
    paragraph = [];
  };
  for (const e of excerpts) {
    const same = previous && previous.page === e.page && previous.heading?.id === e.heading?.id;
    if (previous && !same) {
      flush();
      lines.push('', ref(previous.page));
    }
    if (e.kind === 'paragraph') {
      if (
        previous &&
        (previous.kind !== 'paragraph' || /[。！？!?][」』）)\]】]*\s*$/.test(previous.text))
      )
        flush();
      paragraph.push(literalMarkdown(e.text));
    } else {
      flush();
      if (e.kind === 'heading') lines.push('', `#### ${literalMarkdown(e.text)}`);
      else {
        if (!same || previous?.kind !== 'row') lines.push('');
        lines.push(literalMarkdown(e.text));
      }
    }
    previous = e;
  }
  flush();
  if (previous) lines.push('', ref(previous.page));
  return lines;
}
/** The reviewed table already supplies meaning/axes; only exact numeric arithmetic is added. */
function tableComparisonCells(
  headers: string[],
  cells: string[],
  presentation: SummaryPresentation
): string[] {
  if (cells.some((cell) => /\{\{(?:change|delta):/.test(cell))) return cells;
  const result = [...cells];
  const normalized = headers.map((header) => header.normalize('NFKC').replace(/\s/g, ''));
  for (const [index, header] of normalized.entries()) {
    // A literal 当/前 axis pair must otherwise name the identical metric/period.
    // Unnamed or differently labelled periods remain untouched.
    if (!/当(?:期|年|中間|四半期|連結|事業|第)/.test(header)) continue;
    const referenceHeader = header.replace('当', '前');
    const candidates = normalized.flatMap((name, at) => (name === referenceHeader ? [at] : []));
    if (candidates.length !== 1) continue;
    const id = (cell: string) => cell.match(/^\{\{value:([^{}]+)\}\}$/)?.[1];
    const currentId = id(cells[index]),
      referenceId = id(cells[candidates[0]]);
    const current = presentation.values.find((v) => v.id === currentId);
    const reference = presentation.values.find((v) => v.id === referenceId);
    if (
      !current ||
      !reference ||
      current.decimal === null ||
      reference.decimal === null ||
      !current.unit ||
      current.unit !== reference.unit
    )
      continue;
    const metric = header + ' ' + cells[0];
    const revenue = [header.replace(/[（(].*?[）)]/g, ''), cells[0]].some(
      (label) => reportingMetricKey(label) === 'revenue'
    );
    const kind = /キャッシュ.?フロー|CF/.test(metric)
      ? 'flow'
      : /損失/.test(metric) &&
          !current.decimal.startsWith('-') &&
          !reference.decimal.startsWith('-')
        ? 'loss'
        : /利益|損益/.test(metric)
          ? 'profit'
          : revenue
            ? 'revenue'
            : /受注|残高|数量|販売数/.test(metric)
              ? 'stock'
              : null;
    if (!kind) continue;
    result[index] += `（{{change:${currentId}|${referenceId}|${kind}}}）`;
  }
  return result;
}

function tableTopic(table: NarrativeTable): 'business' | 'orders' | 'cash' | null {
  const title = table.caption.text.normalize('NFKC');
  return /セグメント|事業別|部門別|製品別/.test(title)
    ? 'business'
    : /受注|需要|稼働率/.test(title)
      ? 'orders'
      : /キャッシュ.?フロー|CF/.test(title)
        ? 'cash'
        : null;
}

export function renderSummary(facts: FactSummary, presentation: SummaryPresentation): string {
  if (facts.version !== FACT_SCHEMA_VERSION) throw new Error('旧事実スキーマは表示できません');
  validatePresentation(presentation, facts);
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const sources = new Map(presentation.excerpts.map((e) => [e.id, e]));
  const single = (field: 'subject' | 'scope' | 'basis') => {
    const values = [...new Set(facts.facts.map((f) => f.semantics[field]).filter(Boolean))];
    return values.length === 1 ? values[0] : null;
  };
  const shared = { scope: single('scope'), basis: single('basis') };
  const subjects =
    !['earnings', 'earningsRevision', 'businessUpdate'].includes(facts.documentType) ||
    new Set(facts.facts.map((f) => f.semantics.subject).filter(Boolean)).size > 1;
  const lines: string[] = [];
  const financial = [shared.scope, shared.basis]
    .filter(Boolean)
    .map((s) => literalMarkdown(s!))
    .join('／');
  if (financial) lines.push(`財務情報：${financial}`, '');
  lines.push('## 開示の要点');
  let previousContext = '';
  const overviewFacts = presentation.overview.flatMap((id) => {
    const fact = byId.get(id);
    return fact && numeric(fact) ? [fact] : [];
  });
  for (const f of overviewFacts) {
    const current = context(f, shared, true, subjects);
    if (current && current !== previousContext) {
      lines.push('', current, '');
      previousContext = current;
    }
    lines.push('- ' + overviewNumber(f, facts, presentation));
  }
  for (const id of presentation.overview) {
    const f = byId.get(id);
    if (f && !numeric(f) && /^(?:配当予想|業績予想)：/.test(statementText(f)))
      lines.push('- ' + overviewStatement(f, facts));
  }
  const organization = presentation.organization;
  const accepted = supportedExplanations(organization);
  const tables = supportedTables(organization);
  const unresolved = new Set(
    unresolvedExplanationSources(organization, presentation.excerpts).map((e) => e.id)
  );
  const unresolvedTables = new Set(
    unresolvedTableSources(organization, facts, presentation.values, presentation.excerpts).map(
      (e) => e.id
    )
  );
  const text = (value: string) => literalMarkdown(renderNarrativeText(value, presentation.values));
  if (overviewFacts.length)
    lines.push(
      '',
      `根拠：${references(
        overviewFacts.flatMap((f) => [
          f.page,
          ...(summaryComparison(f, facts.facts)
            ? [summaryComparison(f, facts.facts)!.reference.page]
            : []),
        ])
      )}`
    );
  if (!facts.facts.length)
    lines.push('- 数値・条件を確定できていません。各項目の原文を確認してください。');
  const shownClaims = new Set<string>();
  const shownTables = new Set<string>();
  const titles = sectionPolicies(facts.documentType);
  const destination = (table: NarrativeTable) => {
    const topic = tableTopic(table);
    const role =
      topic === 'cash'
        ? 'finance'
        : topic === 'business'
          ? 'performance'
          : topic === 'orders'
            ? 'operations'
            : null;
    const title = role ? titles.find(([key]) => key === role)?.[1] : null;
    return title && presentation.sections.some((section) => section.title === title) ? title : null;
  };
  const primarySubject = single('subject');
  // Every accepted fact has a body location, independently of organization output.
  for (const section of presentation.sections) {
    const excerpts = section.excerptIds.map((id) => sources.get(id)!);
    const members = section.factIds.map((id) => byId.get(id)!);
    const sectionClaims = accepted.filter(
      (claim) =>
        !shownClaims.has(claim.id) && claim.sourceIds.some((id) => section.excerptIds.includes(id))
    );
    const sectionTables = tables.filter(
      (table) =>
        !shownTables.has(table.caption.id) &&
        (destination(table)
          ? destination(table) === section.title
          : table.caption.sourceIds.some((id) => section.excerptIds.includes(id)))
    );
    lines.push('', `## ${literalMarkdown(section.title)}`);
    const numericFacts = members.filter(numeric);
    const referencesInPairs = new Set(
      numericFacts.flatMap((f) => {
        const pair = summaryComparison(f, facts.facts);
        return pair ? [pair.reference.id] : [];
      })
    );
    const grouped = new Map<string, VerifiedFact[]>();
    for (const fact of numericFacts.filter((f) => !referencesInPairs.has(f.id))) {
      const key = canonicalJSON([periodText(fact), fact.semantics.state, fact.semantics.basis]);
      const group = grouped.get(key) ?? [];
      group.push(fact);
      grouped.set(key, group);
    }
    for (const group of grouped.values()) {
      const f = group[0];
      const subjectColumn = group.some(
        (value) =>
          value.semantics.subject !== primarySubject || value.semantics.scope !== shared.scope
      );
      const headers = [...(subjectColumn ? ['対象'] : []), '指標', '値', '比較値', '増減'];
      lines.push(
        '',
        context(f, shared, true, false),
        '',
        `| ${headers.join(' | ')} |`,
        `| ${headers.map(() => '---').join(' | ')} |`
      );
      const groupConditions = new Set<string>();
      for (const value of group) {
        const comparison = summaryComparison(value, facts.facts);
        const reference = comparison?.reference;
        const cf = /キャッシュ.?フロー|CF|現金及び現金同等物/.test(value.label);
        const growth = comparison && !cf ? overviewGrowth(value, comparison, facts).text : '';
        const change = comparison
          ? cf
            ? quantityChange(
                presentation.values.find((q) => q.id === value.id)!,
                presentation.values.find((q) => q.id === reference!.id)!,
                'flow'
              )
            : comparisonLabel(value, comparison) + growth
          : value.semantics.state === 'actual' || value.semantics.state === 'forecastAfter'
            ? comparisonIssue(value, facts.facts)
            : '';
        const rate = facts.facts.find((r) => canPair(value, r));
        const cells = [
          ...(subjectColumn
            ? [
                [
                  value.semantics.subject !== primarySubject ? value.semantics.subject : null,
                  value.semantics.scope,
                ]
                  .filter(Boolean)
                  .map((s) => literalMarkdown(s!))
                  .join('／'),
              ]
            : []),
          literalMarkdown(value.label),
          numberText(value),
          reference
            ? `${literalMarkdown(periodText(reference) ?? '')} ${numberText(reference)}`
            : '',
          literalMarkdown(change || (rate ? `原文 ${rate.quantity!.raw}${rate.unit}` : '')),
        ];
        lines.push(`| ${cells.join(' | ')} |`);
        const conditions = [
          ...new Set([
            ...value.semantics.qualifiers,
            ...value.semantics.conditions,
            ...(reference
              ? [...reference.semantics.qualifiers, ...reference.semantics.conditions]
              : []),
          ]),
        ];
        for (const condition of conditions) groupConditions.add(condition);
      }
      for (const condition of groupConditions)
        lines.push(`- 比較条件：${literalMarkdown(condition)}`);
      lines.push(
        '',
        `根拠：${references(
          group.flatMap((value) => [
            value.page,
            ...(summaryComparison(value, facts.facts)
              ? [summaryComparison(value, facts.facts)!.reference.page]
              : []),
          ])
        )}`
      );
    }
    sectionTables.sort((a, b) => Number(tableTopic(b) !== null) - Number(tableTopic(a) !== null));
    const shownTopics = new Set<string>();
    for (const table of sectionTables) {
      shownTables.add(table.caption.id);
      const topic = tableTopic(table);
      if (topic && !shownTopics.has(topic)) {
        shownTopics.add(topic);
        lines.push(
          '',
          `### ${{ business: '事業別業績', orders: '受注・需要の動き', cash: 'キャッシュフロー' }[topic]}`
        );
      }
      lines.push(
        '',
        text(table.caption.text),
        '',
        `| ${table.headers.map(literalMarkdown).join(' | ')} |`,
        `| ${table.headers.map(() => '---').join(' | ')} |`
      );
      for (const row of table.rows)
        lines.push(
          `| ${tableComparisonCells(table.headers, row.cells, presentation).map(text).join(' | ')} |`
        );
      lines.push(
        '',
        `根拠：${references([...table.caption.sourceIds, ...table.rows.flatMap((r) => r.sourceIds)].map((id) => sources.get(id)!.page))}`
      );
    }
    for (const fact of members.filter((f) => !numeric(f))) {
      const statement = statementText(fact);
      if (/^(?:配当予想|業績予想)：/.test(statement))
        lines.push('- ' + overviewStatement(fact, facts));
      else if (fact.kind === 'status') lines.push('- ' + statement);
    }
    for (const claim of sectionClaims) {
      shownClaims.add(claim.id);
      lines.push('- ' + text(claim.text));
    }
    const residual = excerpts.filter((e) => unresolved.has(e.id));
    const headings = new Map<string, number[]>();
    for (const e of residual) {
      const heading = e.heading?.text ?? section.title;
      headings.set(heading, [...(headings.get(heading) ?? []), e.page]);
    }
    for (const [heading, pages] of headings)
      lines.push(`- 要約未作成：${literalMarkdown(heading)} ${references(pages)}`);
    const remainingRows = excerpts.filter((e) => unresolvedTables.has(e.id));
    if (remainingRows.length)
      lines.push(
        `- 未整理の数値・表：${references(remainingRows.map((e) => e.page))}（原文を見る）`
      );
    if (sectionClaims.length)
      lines.push(
        '',
        `根拠：${references(sectionClaims.flatMap((c) => c.sourceIds.map((id) => sources.get(id)!.page)))}`
      );
    if (excerpts.length) lines.push('', '### 原文を見る', ...renderExcerpts(excerpts));
  }
  if (
    overviewFacts.some((f) => {
      const comparison = summaryComparison(f, facts.facts);
      return comparison && overviewGrowth(f, comparison, facts).calculated;
    }) ||
    tables.some((table) =>
      table.rows.some((row) =>
        tableComparisonCells(table.headers, row.cells, presentation).some((cell) =>
          cell.includes('{{change:')
        )
      )
    )
  )
    lines.push('', '※「約」の率は表示金額から計算。原文の増減率と端数処理で異なる場合があります。');
  const forecasts = [
    ...new Set(
      facts.facts
        .filter((f) => f.valueKind?.startsWith('forecast'))
        .map((f) => f.period)
        .filter(Boolean)
    ),
  ];
  const conflicts = presentation.excerpts.filter(
    (e) =>
      e.role === 'outlook' &&
      e.kind === 'paragraph' &&
      /^20\d{2}年\d{1,2}月期(?:通期)?の業績予想/.test(
        e.text.normalize('NFKC').replace(/\s/g, '')
      ) &&
      forecasts.length === 1 &&
      !e.text
        .normalize('NFKC')
        .replace(/\s/g, '')
        .startsWith(forecasts[0]!.normalize('NFKC').replace(/\s/g, ''))
  );
  if (facts.unverified.length || conflicts.length) {
    lines.push('', '## 確認事項');
    for (const e of conflicts)
      lines.push(`- 業績予想の説明と数値表で対象期の表記が一致していません。${ref(e.page)}`);
    if (facts.unverified.length)
      lines.push(
        '- 一部の事実を原文と照合できていません。対応する原文を確認してください。',
        '',
        '### 確認の詳細（原文）',
        ...facts.unverified.map((s) => '- ' + literalMarkdown(s))
      );
  }
  return lines.join('\n');
}
