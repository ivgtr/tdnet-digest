import {
  canonicalJSON,
  FACT_SCHEMA_VERSION,
  type FactSummary,
  type VerifiedFact,
} from './fact-contract';
import { validatePresentation, type SummaryPresentation } from './summary-presentation';
import type { SourceExcerpt } from './summary-source-inventory';
import { renderNarrativeText } from './summary-narrative-renderer';
import { NARRATIVE_TOKEN } from './summary-narrative';
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
/** A reviewed row can carry a reported rate without creating a scoring fact. */
function narrativeGrowth(f: VerifiedFact, presentation: SummaryPresentation) {
  const anchor = f.evidence.kind === 'table' ? f.evidence.valueId : f.evidence.quantityId;
  const candidates = presentation.narrative!.content.sections.flatMap((s) =>
    s.tables.flatMap((t) => {
      const columns = t.headers.flatMap((h, i) => (/前年.*比|前期比|増減率/.test(h) ? [i] : []));
      if (columns.length !== 1) return [];
      return t.rows.flatMap((row) => {
        const native = row.sourceIds.some((id) =>
          presentation.excerpts.some(
            (e) =>
              e.id === id &&
              (f.evidence.kind === 'table'
                ? e.spanIds.includes(f.evidence.valueId)
                : e.blockId === f.evidence.blockId)
          )
        );
        const label = (row.cells.join(' ') + ' ' + t.caption.text + ' ' + t.headers.join(' '))
          .normalize('NFKC')
          .replace(/\s/g, '');
        const mentionsCurrent = row.cells.some((cell) =>
          [...cell.matchAll(NARRATIVE_TOKEN)].some(
            (m) =>
              m[1] === 'value' &&
              (m[2] === f.id ||
                m[2] === anchor ||
                (native &&
                  label.includes(f.label.normalize('NFKC').replace(/\s/g, '')) &&
                  presentation.values.some(
                    (v) =>
                      v.id === m[2] &&
                      v.unit === f.unit &&
                      v.decimal !== null &&
                      f.quantity!.decimal !== null &&
                      v.decimal.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') ===
                        f.quantity!.decimal.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
                  )))
          )
        );
        if (!mentionsCurrent) return [];
        const cell = row.cells[columns[0]];
        const tokens = [...cell.matchAll(NARRATIVE_TOKEN)];
        if (tokens.length !== 1 || tokens[0][1] !== 'value') return [];
        const rate = presentation.values.find((v) => v.id === tokens[0][2]);
        if (!rate || !['%', '％'].includes(rate.unit ?? '') || rate.decimal === null) return [];
        return [
          {
            text: `${literalMarkdown(t.headers[columns[0]])} ${literalMarkdown(renderNarrativeText(cell, presentation.values))}`,
            sourceIds: row.sourceIds,
          },
        ];
      });
    })
  );
  return new Set(candidates.map((c) => c.text)).size === 1 ? candidates[0] : undefined;
}
function overviewNumber(
  f: VerifiedFact,
  facts: FactSummary,
  presentation: SummaryPresentation
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
    return `${literalMarkdown(f.label)}：**${comparisonLabel(f, comparison)}${percent}** ${values}${comparison.axis === 'revision' && rate ? `（原文の増減率 ${numberText(rate)}）` : ''}`;
  }
  const rate = facts.facts.find((r) => canPair(f, r));
  if (rate) return `${literalMarkdown(f.label)}：${numberText(f)}（比率 ${numberText(rate)}）`;
  const reported = narrativeGrowth(f, presentation);
  if (reported) return `${literalMarkdown(f.label)}：${numberText(f)}（${reported.text}）`;
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
export function renderSummary(facts: FactSummary, presentation: SummaryPresentation): string {
  if (facts.version !== FACT_SCHEMA_VERSION) throw new Error('旧事実スキーマは表示できません');
  validatePresentation(presentation, facts);
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const sources = new Map(presentation.excerpts.map((e) => [e.id, e]));
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
  const narrative = presentation.narrative!.content;
  const text = (value: string) => literalMarkdown(renderNarrativeText(value, presentation.values));
  const cited = (ids: string[]) => references(ids.map((id) => sources.get(id)!.page));
  for (const claim of narrative.overview) lines.push('- ' + text(claim.text));
  const overviewSources = narrative.overview.flatMap((c) => c.sourceIds);
  if (overviewFacts.length || overviewSources.length)
    lines.push(
      '',
      `根拠：${references([
        ...overviewFacts.flatMap((f) => [
          f.page,
          ...(summaryComparison(f, facts.facts)
            ? [summaryComparison(f, facts.facts)!.reference.page]
            : []),
        ]),
        ...overviewSources.map((id) => sources.get(id)!.page),
        ...overviewFacts.flatMap(
          (f) =>
            narrativeGrowth(f, presentation)?.sourceIds.map((id) => sources.get(id)!.page) ?? []
        ),
      ])}`
    );
  const quoted = new Set<string>();
  for (const section of narrative.sections) {
    lines.push('', `## ${literalMarkdown(section.title)}`);
    for (const table of section.tables) {
      lines.push(
        '',
        text(table.caption.text),
        '',
        `| ${table.headers.map(literalMarkdown).join(' | ')} |`,
        `| ${table.headers.map(() => '---').join(' | ')} |`
      );
      for (const row of table.rows) lines.push(`| ${row.cells.map(text).join(' | ')} |`);
    }
    for (const claim of section.summary) lines.push('- ' + text(claim.text));
    lines.push('', `根拠：${cited(section.sourceIds)}`);
    const excerpts = section.sourceIds
      .filter((id) => !quoted.has(id))
      .map((id) => sources.get(id)!)
      .sort(
        (a, b) =>
          a.page - b.page || Number(a.blockId.split('b')[1]) - Number(b.blockId.split('b')[1])
      );
    for (const e of excerpts) quoted.add(e.id);
    if (excerpts.length) lines.push('', '### 原文を見る', ...renderExcerpts(excerpts));
  }
  const remaining = presentation.excerpts.filter((e) => !quoted.has(e.id));
  if (remaining.length) lines.push('', '### 原文を見る', ...renderExcerpts(remaining));
  if (
    overviewFacts.some((f) => {
      const comparison = summaryComparison(f, facts.facts);
      return comparison && overviewGrowth(f, comparison, facts).calculated;
    }) ||
    /\{\{change:/.test(JSON.stringify(narrative))
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
