import {
  canonicalJSON,
  FACT_SCHEMA_VERSION,
  type FactSummary,
  type VerifiedFact,
} from './fact-contract';
import { validatePresentation, type SummaryPresentation } from './summary-presentation';
import { unchangedDividend, unchangedDividendReference } from './dividend-semantics';
import type { SourceExcerpt } from './summary-source-inventory';

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
/** Source text must remain literal even when it contains Markdown/HTML delimiters. */
export const literalMarkdown = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+!|~.:/@-]/g, '\\$&')
    .replace(/\n/g, ' ');
const ref = (page: number) => `[p.${page}](tdnet-page:${page})`;
const numeric = (f: VerifiedFact) => f.kind === 'number' || f.kind === 'range';
const periodText = (f: VerifiedFact) =>
  f.period && f.semantics.periodKind.startsWith('cumulativeQ') && !/累計|中間期/.test(f.period)
    ? `${f.period}累計`
    : f.period && f.semantics.periodKind.startsWith('standaloneQ') && !/単独/.test(f.period)
      ? `${f.period}単独`
      : f.period;
function contextText(f: VerifiedFact): string {
  return [
    periodText(f),
    f.semantics.subject,
    f.semantics.scope,
    f.semantics.basis,
    numeric(f) ? stateLabels[f.semantics.state] : null,
    f.semantics.polarity === 'negative'
      ? '否定'
      : f.semantics.polarity === 'mixed'
        ? '肯定・否定を含む'
        : null,
    ...f.semantics.qualifiers,
    ...(f.provenance?.denominator?.value === 1 && !/[1１]株(?:当たり|あたり)/.test(f.label)
      ? ['1株当たり']
      : []),
    ...(f.semantics.metricKind === 'perShare' && unchangedDividend(f.quote)
      ? ['配当予想の変更なし']
      : []),
    ...(unchangedDividendReference(f.quote)?.breakdown
      ? [unchangedDividendReference(f.quote)!.breakdown!]
      : []),
    ...new Set(
      f.provenance?.adjustments.map(
        (a) =>
          ({
            splitAdjusted: '株式分割調整済み',
            beforeSplit: '株式分割前',
            afterSplit: '株式分割後',
          })[a.basis]
      ) ?? []
    ),
  ]
    .filter(Boolean)
    .map((s) => literalMarkdown(s!))
    .join('、');
}
function commonContext(f: VerifiedFact): string {
  return [
    periodText(f),
    f.semantics.subject,
    f.semantics.scope,
    f.semantics.basis,
    stateLabels[f.semantics.state],
  ]
    .filter(Boolean)
    .map((s) => literalMarkdown(s!))
    .join('、');
}
function valueNotes(f: VerifiedFact): string[] {
  return [
    ...(f.semantics.polarity === 'negative'
      ? ['否定']
      : f.semantics.polarity === 'mixed'
        ? ['肯定・否定を含む']
        : []),
    ...f.semantics.qualifiers,
    ...(f.provenance?.denominator?.value === 1 && !/[1１]株(?:当たり|あたり)/.test(f.label)
      ? ['1株当たり']
      : []),
    ...(f.semantics.metricKind === 'perShare' && unchangedDividend(f.quote)
      ? ['配当予想の変更なし']
      : []),
    ...(unchangedDividendReference(f.quote)?.breakdown
      ? [unchangedDividendReference(f.quote)!.breakdown!]
      : []),
    ...new Set(
      f.provenance?.adjustments.map(
        (a) =>
          ({
            splitAdjusted: '株式分割調整済み',
            beforeSplit: '株式分割前',
            afterSplit: '株式分割後',
          })[a.basis]
      ) ?? []
    ),
    ...f.semantics.conditions,
    ...(f.provenance?.adjustments.map((a) => a.text) ?? []),
  ].map(literalMarkdown);
}
const numberText = (f: VerifiedFact) =>
  literalMarkdown(
    (f.quantity!.decimal ??
      ('lower' in f.quantity! ? `${f.quantity!.lower}～${f.quantity!.upper}` : '')) + f.unit
  );
const conditions = (f: VerifiedFact) =>
  f.semantics.conditions.length ? '。' + f.semantics.conditions.map(literalMarkdown).join(' ') : '';
function factLine(f: VerifiedFact): string {
  const content = numeric(f)
    ? `${literalMarkdown(f.label)}: ${numberText(f)}`
    : literalMarkdown(f.statement!);
  return `${content}（${contextText(f)}）${ref(f.page)}${numeric(f) ? conditions(f) : ''}`;
}
function canPair(amount: VerifiedFact, rate: VerifiedFact): boolean {
  if (
    rate.semantics.metricKind !== 'rate' ||
    amount.semantics.metricKind === 'rate' ||
    amount.evidence.kind !== 'table' ||
    rate.evidence.kind !== 'table' ||
    amount.label !== rate.label
  )
    return false;
  return (
    canonicalJSON([
      amount.period,
      amount.valueKind,
      amount.semantics.subject,
      amount.semantics.scope,
      amount.semantics.basis,
      amount.evidence.metricIds,
      amount.evidence.periodIds,
      amount.evidence.contextIds,
      amount.provenance?.tableId,
      amount.semantics.qualifiers,
      amount.semantics.conditions,
      amount.provenance?.adjustments,
    ]) ===
    canonicalJSON([
      rate.period,
      rate.valueKind,
      rate.semantics.subject,
      rate.semantics.scope,
      rate.semantics.basis,
      rate.evidence.metricIds,
      rate.evidence.periodIds,
      rate.evidence.contextIds,
      rate.provenance?.tableId,
      rate.semantics.qualifiers,
      rate.semantics.conditions,
      rate.provenance?.adjustments,
    ])
  );
}

/** PDF extraction fragments are not separate quotations. Preserve the source order,
 * paragraph endings and table rows, with one page reference per continuous source group. */
function renderExcerpts(excerpts: SourceExcerpt[]): string[] {
  const lines: string[] = [];
  let paragraph: string[] = [];
  let previous: SourceExcerpt | undefined;
  const flushParagraph = () => {
    if (paragraph.length) lines.push('', paragraph.join(' '));
    paragraph = [];
  };
  for (const excerpt of excerpts) {
    const sameSource =
      previous && previous.page === excerpt.page && previous.heading?.id === excerpt.heading?.id;
    if (previous && !sameSource) {
      flushParagraph();
      lines.push('', ref(previous.page));
    }
    if (excerpt.kind === 'paragraph') {
      if (
        previous &&
        (previous.kind !== 'paragraph' || /[。！？!?][」』）)\]】]*\s*$/.test(previous.text))
      )
        flushParagraph();
      paragraph.push(literalMarkdown(excerpt.text));
    } else {
      flushParagraph();
      if (excerpt.kind === 'heading') lines.push('', `#### ${literalMarkdown(excerpt.text)}`);
      else {
        if (!sameSource || previous?.kind !== 'row') lines.push('');
        lines.push(literalMarkdown(excerpt.text));
      }
    }
    previous = excerpt;
  }
  flushParagraph();
  if (previous) lines.push('', ref(previous.page));
  return lines;
}

/** No slicing of body content; the presentation validator proves every fact/source reference is retained. */
export function renderSummary(facts: FactSummary, presentation: SummaryPresentation): string {
  if (facts.version !== FACT_SCHEMA_VERSION) throw new Error('旧事実スキーマは表示できません');
  validatePresentation(presentation, facts);
  const byId = new Map(facts.facts.map((f) => [f.id, f]));
  const lines = [
    '## 全体要約',
    ...presentation.overview.map((id) => '- ' + factLine(byId.get(id)!)),
  ];
  for (const section of presentation.sections) {
    lines.push('', `## ${literalMarkdown(section.title)}`);
    const members = section.factIds.map((id) => byId.get(id)!);
    const groups = new Map<string, VerifiedFact[]>();
    for (const f of members.filter(numeric)) {
      const key = canonicalJSON([
        periodText(f),
        f.semantics.subject,
        f.semantics.scope,
        f.semantics.basis,
        f.valueKind,
        f.semantics.state,
      ]);
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    for (const group of groups.values()) {
      const first = group[0];
      const pairs = new Map<string, VerifiedFact>();
      for (const amount of group) {
        const rates = group.filter((rate) => canPair(amount, rate));
        if (rates.length === 1 && group.filter((other) => canPair(other, rates[0])).length === 1)
          pairs.set(amount.id, rates[0]);
      }
      const pairedIds = new Set([...pairs.values()].map((f) => f.id));
      const hasRates = pairs.size > 0;
      const hasNotes = group.some((f) => valueNotes(f).length > 0);
      lines.push(
        '',
        commonContext(first),
        '',
        `| 指標 | 値（原文） |${hasRates ? ' 比率（原文） |' : ''}${hasNotes ? ' 条件・基準 |' : ''}`,
        `| --- | ---: |${hasRates ? ' ---: |' : ''}${hasNotes ? ' --- |' : ''}`
      );
      for (const f of group) {
        if (pairedIds.has(f.id)) continue;
        const rate = pairs.get(f.id);
        const notes = [...new Set([...valueNotes(f), ...(rate ? valueNotes(rate) : [])])].join(
          '。'
        );
        lines.push(
          `| ${literalMarkdown(f.label)} | ${numberText(f)} ${ref(f.page)} |` +
            (hasRates ? ` ${rate ? `${numberText(rate)} ${ref(rate.page)}` : ''} |` : '') +
            (hasNotes ? ` ${notes} |` : '')
        );
      }
    }
    for (const f of members.filter((f) => !numeric(f))) lines.push('- ' + factLine(f));
    const excerpts = section.excerptIds.map(
      (id) => presentation.excerpts.find((e) => e.id === id)!
    );
    const remainder = excerpts.filter(
      (e) =>
        !(e.kind === 'heading' && section.title === e.text) &&
        !members.some(
          (f) =>
            !numeric(f) &&
            f.evidence.kind === 'prose' &&
            f.evidence.blockId === e.blockId &&
            f.statement === e.text
        )
    );
    if (remainder.length) {
      lines.push('', '### 説明・補足（原文）', ...renderExcerpts(remainder));
    }
  }
  if (facts.unverified.length)
    lines.push('', '## 未確認事項', ...facts.unverified.map((s) => '- ' + literalMarkdown(s)));
  return lines.join('\n');
}
