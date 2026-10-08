import { FACT_SCHEMA_VERSION, type FactSummary, type VerifiedFact } from './fact-contract';
import { validatePresentation, type SummaryPresentation } from './summary-presentation';
import type { SourceExcerpt } from './summary-source-inventory';
import { renderNarrativeText } from './summary-narrative-renderer';
import {
  supportedExplanations,
  reconciledOrganizationObservations,
  unresolvedExplanationSources,
  unresolvedTableSources,
} from './summary-organization';
import {
  OBSERVATION_TOPICS,
  factPeriodName as periodText,
  canPair,
  observationChange,
  observationGroup,
  observationRole,
  observationTitles,
  comparisonAxisLabels,
  observationBasis,
  factObservation,
  type ConfirmedObservation,
  type DisclosureObservation,
  type ObservationTopic,
} from './disclosure-observation';
import { literalValue } from './summary-narrative-renderer';
import { sectionPolicies } from './summary-content-policy';
import {
  earningsTarget,
  earningsMissingMajorLabels,
  earningsAdditionalMajorWarnings,
  earningsMetricOrder,
  earningsPeriodOrder,
  matchesEarningsTarget,
  type EarningsTarget,
} from './summary-earnings-policy';
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
  presentation: SummaryPresentation,
  observation: ConfirmedObservation
): string {
  const basis = observationBasis(observation);
  const metric = literalMarkdown(f.label);
  const currentValue = numberText(f) + (basis.length ? `（${basis.join('、')}）` : '');
  if (observation.unresolved) return `${metric}：${currentValue}（指標区分・比較は未確認）`;
  const comparison = summaryComparison(f, facts.facts);
  if (comparison) {
    const before = comparison.reference;
    const previousBasis = observationBasis(observation, true);
    const previousValue =
      numberText(before) + (previousBasis.length ? `（${previousBasis.join('、')}）` : '');
    const values =
      comparison.axis === 'revision'
        ? `${previousValue} → ${currentValue}`
        : `${currentValue}（${f.semantics.periodKind === 'fullYear' ? '前期' : '前年同期'} ${previousValue}）`;
    const percent = overviewGrowth(f, comparison, facts).text;
    const interpretation =
      observation.measure !==
      factObservation(f, facts, presentation.excerpts, presentation.values).measure
        ? observationChange(observation, presentation.values).text
        : comparisonLabel(f, comparison) + percent;
    const rate = facts.facts.find((r) => canPair(f, r));
    return `${metric}：**${comparison.axis === 'revision' ? comparisonLabel(f, comparison) + literalMarkdown(percent) : literalMarkdown(interpretation)}** ${values}${comparison.axis === 'revision' && rate ? `（原文の増減率 ${numberText(rate)}）` : ''}`;
  }
  const rate = facts.facts.find((r) => canPair(f, r));
  if (rate) return `${metric}：${currentValue}（比率 ${numberText(rate)}）`;
  return `${metric}：${currentValue}${f.semantics.state === 'actual' || f.semantics.state === 'forecastAfter' ? `（${comparisonIssue(f, facts.facts)}）` : ''}`;
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
      if (e.kind === 'heading') lines.push('', `##### ${literalMarkdown(e.text)}`);
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
  records: Array<DisclosureObservation | ConfirmedObservation>,
  presentation: SummaryPresentation,
  primarySubject: string | null,
  headings: boolean,
  earnings?: { target: EarningsTarget | null }
): string[] {
  const lines: string[] = [];
  const groups = new Map<string, Array<DisclosureObservation | ConfirmedObservation>>();
  for (const observation of records) {
    const key =
      observationGroup(observation) +
      (earnings ? JSON.stringify([observation.period, observation.state]) : '');
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const topics = new Set<ObservationTopic>();
  const text = (value: string) => literalMarkdown(renderNarrativeText(value, presentation.values));
  const periodOrder = (a: DisclosureObservation, b: DisclosureObservation) => {
    const left = earningsPeriodOrder(a.period, earnings?.target ?? null);
    const right = earningsPeriodOrder(b.period, earnings?.target ?? null);
    return (
      left[0] - right[0] ||
      Number(b.scope === earnings?.target?.scope) - Number(a.scope === earnings?.target?.scope) ||
      left[1] - right[1] ||
      left[2].localeCompare(right[2])
    );
  };
  const metricOrder = (a: DisclosureObservation, b: DisclosureObservation) =>
    earningsMetricOrder(a.metric) - earningsMetricOrder(b.metric) ||
    a.metric.localeCompare(b.metric) ||
    (a.entity ?? '').localeCompare(b.entity ?? '') ||
    a.valueId.localeCompare(b.valueId);
  for (const group of [...groups.values()].sort(
    (a, b) =>
      OBSERVATION_TOPICS.indexOf(a[0].topic) - OBSERVATION_TOPICS.indexOf(b[0].topic) ||
      (earnings
        ? periodOrder(a[0], b[0]) ||
          a[0].state.localeCompare(b[0].state) ||
          observationGroup(a[0]).localeCompare(observationGroup(b[0]))
        : 0)
  )) {
    if (earnings) group.sort(metricOrder);
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
    if (earnings)
      lines.push(
        '',
        `### ${literalMarkdown(first.period ?? '対象期未特定')} ${stateLabels[first.state]}`
      );
    lines.push(
      '',
      [
        !earnings && periods.length === 1 ? first.period : null,
        !earnings && states.length === 1 ? stateLabels[first.state] : null,
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
      const previousBasis = observationBasis(value, true);
      const cells = [
        ...(subject ? [literalMarkdown(value.entity ?? '全社')] : []),
        ...(periods.length > 1 ? [literalMarkdown(value.period ?? '対象期未特定')] : []),
        ...(states.length > 1 ? [stateLabels[value.state]] : []),
        literalMarkdown(
          value.metric +
            (observationBasis(value).length ? `（${observationBasis(value).join('、')}）` : '')
        ),
        literalMarkdown(literalValue(quantity)),
        comparison
          ? `${comparisonAxisLabels[comparison.axis]} ${literalMarkdown(comparison.period)} ${literalMarkdown(literalValue(previous!))}${previousBasis.length ? `（${previousBasis.join('、')}）` : ''}`
          : '',
        literalMarkdown(
          observationChange(value, presentation.values).text ||
            (value.state === 'actual' || value.state === 'forecastAfter' ? '比較未確認' : '')
        ),
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
    for (const condition of first.conditions) lines.push(`- 比較条件：${text(condition)}`);
    const notes = new Map(
      group.flatMap((value) =>
        'sourceBasis' in value
          ? [
              ...value.sourceBasis.adjustments,
              ...(value.comparisonSourceBasis?.adjustments ?? []),
            ].map((a) => [a.noteId, a] as const)
          : []
      )
    );
    for (const note of notes.values()) {
      const source = presentation.excerpts.find((e) => e.blockId === note.noteId);
      lines.push(
        `- 比較条件（原文）：${literalMarkdown(note.text)}${source ? ` ${ref(source.page)}` : ''}`
      );
    }
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
  const organization = presentation.organization;
  const accepted = supportedExplanations(organization);
  const reconciled = reconciledOrganizationObservations(
    organization,
    facts,
    presentation.values,
    presentation.excerpts
  );
  const observations = reconciled.accepted;
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
  const earnings = facts.documentType === 'earnings' ? earningsTarget(presentation.excerpts) : null;
  lines.push('## 開示の要点');
  if (earnings) {
    const missing = earningsMissingMajorLabels(facts, earnings.target);
    const additional = earningsAdditionalMajorWarnings(facts);
    const missingAttributes = earnings.target
      ? (['subject', 'scope', 'basis'] as const)
          .filter((role) => !earnings.target![role]?.trim())
          .map((role) => ({ subject: '会社', scope: '範囲', basis: '会計基準' })[role])
      : [];
    if (earnings.issue)
      lines.push(
        '',
        missingAttributes.length
          ? `**要確認：報告対象の${missingAttributes.join('・')}が未特定です。**`
          : '**要確認：報告対象期が未特定です。**',
        '原文の報告対象を一意に確認できないため、数値を当期の要点として選んでいません。確認済みの数値は対象期とともに本文に表示しています。'
      );
    if (missing.length || additional.length)
      lines.push(
        '',
        '**要確認：主要数値に未確認項目があります。**',
        ...(missing.length
          ? [
              `- ${earnings.target ? literalMarkdown(earnings.target.label) + ' 実績の' : ''}未確認：${missing.map(literalMarkdown).join('、')}`,
            ]
          : []),
        ...additional.map((warning) => `- 未確認の${literalMarkdown(warning)}`),
        '確認済みの項目だけを表示しています。'
      );
  }
  let previousContext = '';
  const overviewFacts = presentation.overview.flatMap((id) => {
    const fact = byId.get(id);
    return fact &&
      numeric(fact) &&
      (!earnings ||
        fact.semantics.state !== 'actual' ||
        matchesEarningsTarget(fact, earnings.target))
      ? [fact]
      : [];
  });
  for (const f of overviewFacts) {
    const current = context(f, shared, true, subjects);
    if (current && current !== previousContext) {
      lines.push('', current, '');
      previousContext = current;
    }
    lines.push('- ' + overviewNumber(f, facts, presentation, reconciled.primary.get(f.id)!));
  }
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
    if (fact && (!claims.length || unresolved.has(source.id))) {
      const section = presentation.sections.find((s) => s.excerptIds.includes(source.id))!;
      lines.push(
        `- 確認済み事項（原文）：「${literalMarkdown(section.title)}」に記載 ${ref(fact.page)}`
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
    const members = section.factIds.map((id) => byId.get(id)!);
    const sectionClaims = accepted.filter(
      (value) => destination(value.topic, value.sourceIds) === section.title
    );
    const sectionObservations = reconciled.supplement.filter(
      (value) => destination(value.topic, value.sourceIds) === section.title
    );
    if (!members.length && !sectionClaims.length && !sectionObservations.length) continue;
    lines.push('', `## ${literalMarkdown(section.title)}`);
    const numericRows = members.filter(numeric).map((fact) => reconciled.primary.get(fact.id)!);
    const referencesInPairs = new Set(
      numericRows.flatMap((row) => (row.comparison ? [row.comparison.valueId] : []))
    );
    // Keep every comparison owner. Only a leaf already displayed by one of
    // those retained rows can be omitted, regardless of the incoming order.
    const primary = numericRows.filter(
      (row) => row.comparison !== null || !referencesInPairs.has(row.valueId)
    );
    const supplement = sectionObservations;
    lines.push(
      ...renderObservationGroups(
        primary,
        presentation,
        primarySubject,
        false,
        earnings ?? undefined
      )
    );
    lines.push(
      ...renderObservationGroups(
        supplement,
        presentation,
        primarySubject,
        true,
        earnings ?? undefined
      )
    );
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
      // Linked notes qualify a verified statement even when the optional
      // explanation is unavailable. Inline qualifications are already visible.
      const compact = (value: string) => value.normalize('NFKC').replace(/\s/g, '');
      const statementSource = compact(fact.statement!);
      const conditionSources = new Set([
        ...fact.evidence.contextIds,
        ...fact.evidence.qualifierIds,
      ]);
      for (const condition of new Set([
        ...fact.semantics.qualifiers,
        ...fact.semantics.conditions,
      ])) {
        if (statementSource.includes(compact(condition))) continue;
        const pages = presentation.excerpts
          .filter(
            (excerpt) =>
              (conditionSources.has(excerpt.blockId) ||
                excerpt.spanIds.some((id) => conditionSources.has(id))) &&
              compact(excerpt.text).includes(compact(condition))
          )
          .map((excerpt) => excerpt.page);
        lines.push(
          `- 条件・限定（原文）：${literalMarkdown(condition)} ${references(pages.length ? pages : [fact.page])}`
        );
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
    if (sectionClaims.length)
      lines.push(
        '',
        `根拠：${references(sectionClaims.flatMap((c) => c.sourceIds.map((id) => sources.get(id)!.page)))}`
      );
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
  // Disclose missing coverage once, without interleaving unorganized source material
  // with confirmed facts. The same Markdown remains complete when copied or restored.
  if (unresolved.size || unresolvedTables.size || reconciled.conflicts.length) {
    lines.push(
      '',
      '## 補足要約の未整理部分',
      '',
      '以下には要約に反映できていない説明・数値があります。末尾の原文を確認してください。'
    );
    for (const metric of new Set(reconciled.conflicts.map((c) => c.metric)))
      lines.push(
        `- 補足指標の未整理：${literalMarkdown(metric)}の指標区分・期間・比較に不一致があります。確認済みの数値は本文に表示しています`
      );
    for (const section of sections) {
      const excerpts = section.excerptIds.map((id) => sources.get(id)!);
      const remaining = [
        ['説明', unresolved],
        ['数値・表', unresolvedTables],
      ] as const;
      const coverage = remaining.flatMap(([label, ids]) => {
        const pages = excerpts.filter((e) => ids.has(e.id)).map((e) => e.page);
        return pages.length ? [`${label} ${references(pages)}`] : [];
      });
      if (coverage.length)
        lines.push(`- ${literalMarkdown(section.title)}：${coverage.join('／')}`);
    }
  }
  if (presentation.excerpts.length) {
    lines.push('', '## 原文', '', '### 原文を見る');
    for (const section of sections) {
      const excerpts = section.excerptIds.map((id) => sources.get(id)!);
      if (excerpts.length)
        lines.push('', `#### ${literalMarkdown(section.title)}`, ...renderExcerpts(excerpts));
    }
  }
  return lines.join('\n');
}
