import { FACT_SCHEMA_VERSION, type FactSummary, type VerifiedFact } from './fact-contract';
import { validatePresentation, type SummaryPresentation } from './summary-presentation';
import type { SourceExcerpt } from './summary-source-inventory';
import { renderNarrativeText } from './summary-narrative-renderer';
import {
  supportedExplanations,
  supportedObservations,
  unresolvedExplanationSources,
  unresolvedTableSources,
} from './summary-organization';
import {
  OBSERVATION_TOPICS,
  reconcileObservations,
  factPeriodName as periodText,
  canPair,
  observationChange,
  observationGroup,
  observationRole,
  observationTitles,
  comparisonAxisLabels,
  type DisclosureObservation,
  type ObservationTopic,
} from './disclosure-observation';
import { literalValue } from './summary-narrative-renderer';
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
/** Layout is a projection of semantic records; no caption/header parsing. */
function renderObservationGroups(
  records: DisclosureObservation[],
  presentation: SummaryPresentation,
  primarySubject: string | null,
  headings: boolean
): string[] {
  const lines: string[] = [];
  const groups = new Map<string, DisclosureObservation[]>();
  for (const observation of records) {
    const key = observationGroup(observation);
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const topics = new Set<ObservationTopic>();
  const text = (value: string) => literalMarkdown(renderNarrativeText(value, presentation.values));
  for (const group of [...groups.values()].sort(
    (a, b) => OBSERVATION_TOPICS.indexOf(a[0].topic) - OBSERVATION_TOPICS.indexOf(b[0].topic)
  )) {
    const first = group[0];
    if (headings && !topics.has(first.topic)) {
      topics.add(first.topic);
      lines.push('', `### ${observationTitles[first.topic]}`);
    }
    const subject = group.some((value) => value.entity !== null && value.entity !== primarySubject);
    const periods = [...new Set(group.map((v) => v.period))];
    const states = [...new Set(group.map((v) => v.state))];
    const headers = [
      ...(subject ? ['対象'] : []),
      ...(periods.length > 1 ? ['対象期'] : []),
      ...(states.length > 1 ? ['区分'] : []),
      '指標',
      '値',
      '比較値',
      '増減',
    ];
    lines.push(
      '',
      [
        periods.length === 1 ? first.period : null,
        states.length === 1 ? stateLabels[first.state] : null,
        first.scope,
        first.basis,
      ]
        .filter(Boolean)
        .map((v) => literalMarkdown(v!))
        .join('／'),
      '',
      `| ${headers.join(' | ')} |`,
      `| ${headers.map(() => '---').join(' | ')} |`
    );
    for (const value of group) {
      const quantity = presentation.values.find((q) => q.id === value.valueId)!;
      const comparison = value.comparison;
      const previous = comparison
        ? presentation.values.find((q) => q.id === comparison.valueId)!
        : null;
      const cells = [
        ...(subject ? [literalMarkdown(value.entity ?? '全社')] : []),
        ...(periods.length > 1 ? [literalMarkdown(value.period ?? '対象期未特定')] : []),
        ...(states.length > 1 ? [stateLabels[value.state]] : []),
        literalMarkdown(value.metric),
        literalMarkdown(literalValue(quantity)),
        comparison
          ? `${comparisonAxisLabels[comparison.axis]} ${literalMarkdown(comparison.period)} ${literalMarkdown(literalValue(previous!))}`
          : '',
        literalMarkdown(
          observationChange(value, presentation.values).text ||
            (value.state === 'actual' || value.state === 'forecastAfter' ? '比較未確認' : '')
        ),
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    for (const condition of first.conditions) lines.push(`- 比較条件：${text(condition)}`);
    lines.push(
      '',
      `根拠：${references(group.flatMap((value) => value.sourceIds.map((id) => presentation.excerpts.find((e) => e.id === id)!.page)))}`
    );
  }
  return lines;
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
  const organization = presentation.organization;
  const accepted = supportedExplanations(organization);
  const observations = supportedObservations(organization);
  const reconciled = reconcileObservations(
    facts,
    observations,
    presentation.excerpts,
    presentation.values
  );
  const unresolved = new Set(
    unresolvedExplanationSources(organization, presentation.excerpts).map((e) => e.id)
  );
  const unresolvedTables = new Set(
    unresolvedTableSources(organization, facts, presentation.values, presentation.excerpts).map(
      (e) => e.id
    )
  );
  const text = (value: string) => literalMarkdown(renderNarrativeText(value, presentation.values));
  const overviewClaims = new Set<string>();
  for (const id of presentation.overview) {
    const fact = byId.get(id);
    if (fact && numeric(fact)) continue;
    if (fact && /^(?:配当予想|業績予想)：/.test(statementText(fact))) {
      lines.push('- ' + overviewStatement(fact, facts));
      continue;
    }
    const source = fact
      ? presentation.excerpts.find(
          (e) => fact.evidence.kind === 'prose' && e.blockId === fact.evidence.blockId
        )
      : sources.get(id);
    if (!source) continue;
    const claims = accepted.filter((claim) => claim.sourceIds.includes(source.id));
    for (const claim of claims) {
      if (overviewClaims.has(claim.id)) continue;
      overviewClaims.add(claim.id);
      const claimContext = [
        claim.period,
        claim.state !== 'actual' && claim.state !== 'unspecified' ? stateLabels[claim.state] : null,
        claim.scope,
        claim.basis,
      ].filter(Boolean);
      if (claimContext.length)
        lines.push('', claimContext.map((s) => literalMarkdown(s!)).join('／'));
      lines.push(
        '- ' + (claim.entity ? `**${literalMarkdown(claim.entity)}**：` : '') + text(claim.text)
      );
      for (const condition of claim.conditions) lines.push('- 条件：' + text(condition));
      lines.push(
        `根拠：${references(claim.sourceIds.map((sourceId) => sources.get(sourceId)!.page))}`
      );
    }
    if (!claims.length || unresolved.has(source.id)) {
      const section = presentation.sections.find((s) => s.excerptIds.includes(source.id))!;
      lines.push(
        fact
          ? `- 確認済み事項（原文）：「${literalMarkdown(section.title)}」に記載 ${ref(fact.page)}${unresolved.has(source.id) ? '（説明は未整理）' : ''}`
          : `- ${claims.length ? '要点の説明に未整理部分' : '要点の説明未作成'}：${literalMarkdown(source.heading?.text ?? section.title)} ${ref(source.page)}（原文を見る）`
      );
    }
  }
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
  const titles = sectionPolicies(facts.documentType);
  const destination = (topic: ObservationTopic, sourceIds: string[]) => {
    const role = observationRole(topic);
    return (
      (role ? titles.find(([key]) => key === role)?.[1] : null) ??
      presentation.sections.find((section) =>
        sourceIds.some((id) => section.excerptIds.includes(id))
      )?.title ??
      titles[0][1]
    );
  };
  const sectionTitles = new Set([
    ...presentation.sections.map((section) => section.title),
    ...reconciled.supplement.map((value) => destination(value.topic, value.sourceIds)),
    ...accepted.map((value) => destination(value.topic, value.sourceIds)),
  ]);
  const sections = titles
    .filter(([, title]) => sectionTitles.has(title))
    .map(
      ([, title]) =>
        presentation.sections.find((section) => section.title === title) ?? {
          title,
          factIds: [],
          excerptIds: [],
          highlights: [],
        }
    );
  const primarySubject = single('subject');
  // Every accepted fact has a body location, independently of organization output.
  for (const section of sections) {
    const excerpts = section.excerptIds.map((id) => sources.get(id)!);
    const members = section.factIds.map((id) => byId.get(id)!);
    const sectionClaims = accepted.filter(
      (value) => destination(value.topic, value.sourceIds) === section.title
    );
    const sectionObservations = reconciled.supplement.filter(
      (value) => destination(value.topic, value.sourceIds) === section.title
    );
    lines.push('', `## ${literalMarkdown(section.title)}`);
    const numericFacts = members.filter(numeric);
    const referencesInPairs = new Set(
      numericFacts.flatMap((f) => {
        const pair = summaryComparison(f, facts.facts);
        return pair ? [pair.reference.id] : [];
      })
    );
    const primary = numericFacts
      .filter((f) => !referencesInPairs.has(f.id))
      .map((f) => reconciled.primary.get(f.id)!);
    const supplement = sectionObservations;
    lines.push(...renderObservationGroups(primary, presentation, primarySubject, false));
    lines.push(...renderObservationGroups(supplement, presentation, primarySubject, true));
    const structured = [...primary, ...supplement];
    const shownConditions = new Set(structured.flatMap((value) => value.conditions));
    const shownClaimContexts = new Set<string>();
    for (const fact of members.filter((f) => !numeric(f))) {
      const statement = statementText(fact);
      if (/^(?:配当予想|業績予想)：/.test(statement))
        lines.push('- ' + overviewStatement(fact, facts));
      else {
        const factContext = context(fact, shared, true, subjects);
        if (factContext) lines.push('', factContext);
        lines.push(`- 確認済み事項（原文）：${statement} ${ref(fact.page)}`);
      }
    }
    for (const claim of sectionClaims) {
      const claimContext = [claim.period, claim.state, claim.scope, claim.basis].join('|');
      if (
        !shownClaimContexts.has(claimContext) &&
        !structured.some(
          (value) =>
            value.period === claim.period &&
            value.state === claim.state &&
            value.scope === claim.scope &&
            value.basis === claim.basis
        )
      ) {
        shownClaimContexts.add(claimContext);
        const context = [
          claim.period,
          claim.state !== 'actual' && claim.state !== 'unspecified'
            ? stateLabels[claim.state]
            : null,
          claim.scope !== shared.scope ? claim.scope : null,
          claim.basis !== shared.basis ? claim.basis : null,
        ].filter(Boolean);
        if (context.length) lines.push('', context.map((s) => literalMarkdown(s!)).join('／'));
      }
      lines.push(
        '- ' + (claim.entity ? `**${literalMarkdown(claim.entity)}**：` : '') + text(claim.text)
      );
      for (const condition of claim.conditions) {
        if (shownConditions.has(condition)) continue;
        shownConditions.add(condition);
        lines.push('- 条件：' + text(condition));
      }
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
    observations.some((value) => observationChange(value, presentation.values).calculated)
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
