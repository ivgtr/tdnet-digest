import {
  canonicalJSON,
  FACT_SCHEMA_VERSION,
  type FactSummary,
  type VerifiedFact,
} from './fact-contract';
import { validatePresentation, type SummaryPresentation } from './summary-presentation';
import { unchangedDividend, unchangedDividendReference } from './dividend-semantics';
import { paragraphGroups, type SourceExcerpt } from './summary-source-inventory';
import { explanationRole } from './summary-content-policy';
import { companyExcerpt } from './summary-company-excerpt';
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
function valueNotes(f: VerifiedFact): string[] {
  return [
    ...new Set([
      ...f.semantics.qualifiers,
      ...f.semantics.conditions,
      ...(f.provenance?.denominator?.value === 1 && !/[1１]株(?:当たり|あたり)/.test(f.label)
        ? ['1株当たり']
        : []),
      ...(f.semantics.metricKind === 'perShare' && unchangedDividend(f.quote)
        ? ['配当予想の変更なし']
        : []),
      ...(unchangedDividendReference(f.quote)?.breakdown
        ? [unchangedDividendReference(f.quote)!.breakdown!]
        : []),
      ...(f.provenance?.adjustments.flatMap((a) => [
        { splitAdjusted: '株式分割調整済み', beforeSplit: '株式分割前', afterSplit: '株式分割後' }[
          a.basis
        ],
        a.text,
      ]) ?? []),
    ]),
  ].map(literalMarkdown);
}
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
    return { text: `（原文 ${numberText(rate)}）`, calculated: false };
  if (growth?.kind === 'zeroBase')
    return {
      text: `（${f.semantics.periodKind === 'fullYear' ? '前期' : '前年同期'}0のため比率なし）`,
      calculated: false,
    };
  return {
    text: growth ? ` 約${literalMarkdown(growth.rate)}` : '',
    calculated: growth !== null,
  };
}
function overviewNumber(f: VerifiedFact, facts: FactSummary): string {
  const comparison = summaryComparison(f, facts.facts);
  if (comparison) {
    const before = comparison.reference;
    const values =
      comparison.axis === 'revision'
        ? `${numberText(before)} → ${numberText(f)}`
        : `${numberText(f)}（${f.semantics.periodKind === 'fullYear' ? '前期' : '前年同期'} ${numberText(before)}）`;
    const percent = overviewGrowth(f, comparison, facts).text;
    const rate = facts.facts.find((r) => canPair(f, r));
    return `${literalMarkdown(f.label)}：**${comparisonLabel(f, comparison)}${percent}** ${values}${comparison.axis === 'revision' && rate ? `（原文の増減率 ${numberText(rate)}）` : ''}`;
  }
  const rate = facts.facts.find((r) => canPair(f, r));
  if (rate) return `${literalMarkdown(f.label)}：${numberText(f)}（比率 ${numberText(rate)}）`;
  return `${literalMarkdown(f.label)}：${numberText(f)}${f.semantics.state === 'actual' || f.semantics.state === 'forecastAfter' ? `（${comparisonIssue(f, facts.facts)}）` : ''}`;
}
function overviewStatement(f: VerifiedFact, facts: FactSummary): string {
  if (['reason', 'condition'].includes(explanationRole(f.statement!) ?? '')) {
    const excerpt = companyExcerpt({ text: f.statement!, role: 'reason' }, { comparisons: false });
    return `会社説明（原文抜粋）：${literalMarkdown(excerpt === null ? f.statement! : excerpt)}`;
  }
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
function columnKey(f: VerifiedFact): string {
  return canonicalJSON([periodText(f), f.semantics.state]);
}
function rowKey(f: VerifiedFact): string {
  return canonicalJSON([
    f.label,
    f.unit,
    f.semantics.metricKind,
    f.semantics.polarity,
    f.semantics.qualifiers,
    f.semantics.conditions,
    f.provenance?.adjustments,
  ]);
}
function renderNumbers(
  members: VerifiedFact[],
  shared: { scope: string | null; basis: string | null },
  subjects: boolean
): string[] {
  const lines: string[] = [];
  const groups = new Map<string, VerifiedFact[]>();
  for (const f of members.filter(numeric)) {
    const family = f.semantics.state.startsWith('forecast') ? 'forecast' : f.semantics.state;
    const key = canonicalJSON([
      f.semantics.subject,
      f.semantics.scope,
      f.semantics.basis,
      f.semantics.periodKind,
      family,
      // A shared original table/assertion proves a comparison relationship.
      f.provenance?.tableId ?? f.provenance?.assertion?.id ?? f.id,
    ]);
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const group of groups.values()) {
    const pairs = new Map<string, VerifiedFact>();
    for (const amount of group) {
      const rates = group.filter((r) => canPair(amount, r));
      if (rates.length === 1 && group.filter((a) => canPair(a, rates[0])).length === 1)
        pairs.set(amount.id, rates[0]);
    }
    const paired = new Set([...pairs.values()].map((f) => f.id));
    const amounts = group.filter((f) => !paired.has(f.id));
    const columns = [...new Map(amounts.map((f) => [columnKey(f), f])).values()].sort((a, b) =>
      a.semantics.state === 'forecastBefore' && b.semantics.state === 'forecastAfter'
        ? -1
        : a.semantics.state === 'forecastAfter' && b.semantics.state === 'forecastBefore'
          ? 1
          : (b.period ?? '').localeCompare(a.period ?? '')
    );
    const units = [...new Set(amounts.map((f) => f.unit))];
    const commonUnit = units.length === 1 ? units[0] : null;
    const pages = [...new Set(group.map((f) => f.page))];
    const individualRefs = pages.length > 1;
    const notes = group.some((f) => valueNotes(f).length > 0);
    const title = context(group[0], shared, false, subjects);
    if (title) lines.push('', title);
    const rateColumns = columns.map((c) =>
      group.some((f) => columnKey(f) === columnKey(c) && pairs.has(f.id))
    );
    const headers = ['指標'];
    const align = ['---'];
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      headers.push(
        `${literalMarkdown(periodText(c) ?? '')} ${c.semantics.state === 'unspecified' ? '' : stateLabels[c.semantics.state]}${commonUnit ? `（${literalMarkdown(commonUnit)}）` : ''}`.trim()
      );
      align.push('---:');
      if (rateColumns[i]) {
        headers.push('比率（％）');
        align.push('---:');
      }
    }
    if (notes) {
      headers.push('条件・基準');
      align.push('---');
    }
    lines.push('', `| ${headers.join(' | ')} |`, `| ${align.join(' | ')} |`);
    const rows = new Map<string, VerifiedFact[]>();
    for (const f of amounts) rows.set(rowKey(f), [...(rows.get(rowKey(f)) ?? []), f]);
    for (const row of rows.values()) {
      const queues = columns.map((c) => row.filter((f) => columnKey(c) === columnKey(f)));
      while (queues.some((q) => q.length)) {
        const cells = [literalMarkdown(row[0].label)];
        const rowNotes: string[] = [];
        for (let i = 0; i < columns.length; i++) {
          const f = queues[i].shift();
          const rate = f ? pairs.get(f.id) : undefined;
          cells.push(
            f ? numberText(f, !commonUnit) + (individualRefs ? ` ${ref(f.page)}` : '') : ''
          );
          if (rateColumns[i])
            cells.push(
              rate ? numberText(rate, false) + (individualRefs ? ` ${ref(rate.page)}` : '') : ''
            );
          if (f) rowNotes.push(...valueNotes(f));
          if (rate) rowNotes.push(...valueNotes(rate));
        }
        if (notes) cells.push([...new Set(rowNotes)].join('。'));
        lines.push(`| ${cells.join(' | ')} |`);
      }
    }
    lines.push('', `根拠：${references(pages)}`);
  }
  return lines;
}
export function renderSummary(facts: FactSummary, presentation: SummaryPresentation): string {
  if (facts.version !== FACT_SCHEMA_VERSION) throw new Error('旧事実スキーマは表示できません');
  validatePresentation(presentation, facts);
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const sources = new Map(presentation.excerpts.map((e) => [e.id, e]));
  const explanations = new Map(paragraphGroups(presentation.excerpts).map((e) => [e.id, e]));
  const single = (field: 'scope' | 'basis') => {
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
  for (let index = 0; index < presentation.overview.length; index++) {
    const id = presentation.overview[index];
    const f = byId.get(id);
    if (f) {
      const current = context(f, shared, true, subjects);
      if (current && current !== previousContext) {
        lines.push('', current, '');
        previousContext = current;
      }
      const notes = valueNotes(f).join('。');
      let text =
        (numeric(f) ? overviewNumber(f, facts) : overviewStatement(f, facts)) +
        (notes ? `（${notes}）` : '');
      while (index + 1 < presentation.overview.length) {
        const next = byId.get(presentation.overview[index + 1]);
        if (
          !next ||
          context(next, shared, true, subjects) !== current ||
          (numeric(f) && ['earnings', 'earningsRevision'].includes(facts.documentType)) ||
          numeric(f) !== numeric(next)
        )
          break;
        index++;
        const nextNotes = valueNotes(next).join('。');
        text +=
          '、' +
          (numeric(next) ? overviewNumber(next, facts) : overviewStatement(next, facts)) +
          (nextNotes ? `（${nextNotes}）` : '');
      }
      lines.push('- ' + text);
    } else {
      const e = explanations.get(id)!;
      let text = literalMarkdown(companyExcerpt(e, { comparisons: false })!);
      while (explanationRole(e.text) === 'reason' && index + 1 < presentation.overview.length) {
        const next = explanations.get(presentation.overview[index + 1]);
        if (!next || explanationRole(next.text) !== 'reason') break;
        text += '／' + literalMarkdown(companyExcerpt(next, { comparisons: false })!);
        index++;
      }
      lines.push(`- 会社説明（原文抜粋）：${text}`);
    }
  }
  const overviewFacts = presentation.overview.flatMap((id) => {
    const fact = byId.get(id);
    return fact ? [fact] : [];
  });
  if (
    overviewFacts.some((f) => {
      const comparison = summaryComparison(f, facts.facts);
      return comparison && overviewGrowth(f, comparison, facts).calculated;
    })
  )
    lines.push('', '※「約」の率は表示金額から計算。原文の増減率と端数処理で異なる場合があります。');
  if (presentation.overview.length)
    lines.push(
      '',
      `根拠：${references([
        ...presentation.overview.map((id) => byId.get(id)?.page ?? sources.get(id)!.page),
        ...overviewFacts.flatMap((f) => {
          const comparison = summaryComparison(f, facts.facts);
          return comparison ? [comparison.reference.page] : [];
        }),
      ])}`
    );
  for (const section of presentation.sections) {
    const members = section.factIds.map((id) => byId.get(id)!);
    const excerpts = section.excerptIds.map((id) => sources.get(id)!);
    if (!members.length && excerpts.every((e) => e.kind === 'heading')) {
      // Heading-only content stays in a closed source group, never an empty reading heading.
      lines.push('', '### 原文を見る', ...renderExcerpts(excerpts));
      continue;
    }
    lines.push(
      '',
      `## ${literalMarkdown(section.title)}`,
      ...renderNumbers(members, shared, subjects)
    );
    let previous = '';
    for (const f of members.filter((f) => !numeric(f))) {
      const ctx = context(f, shared, true, subjects);
      if (ctx && ctx !== previous) {
        lines.push('', ctx, '');
        previous = ctx;
      }
      const statement = statementText(f);
      const notes = valueNotes(f).filter((note) => !statement.includes(note));
      lines.push('- ' + statement + (notes.length ? `（${notes.join('。')}）` : ''));
    }
    const prose = members.filter((f) => !numeric(f));
    if (prose.length) lines.push('', `根拠：${references(prose.map((f) => f.page))}`);
    if (section.highlights.length) {
      lines.push('', '**会社説明（原文抜粋）**');
      for (const id of section.highlights)
        lines.push('- ' + literalMarkdown(companyExcerpt(explanations.get(id)!)!));
      lines.push('', `根拠：${references(section.highlights.map((id) => sources.get(id)!.page))}`);
    }
    if (excerpts.length) lines.push('', `### 原文を見る`, ...renderExcerpts(excerpts));
  }
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
