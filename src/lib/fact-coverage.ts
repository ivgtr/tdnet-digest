import type { ExtractedPage } from '@/types/summaryMetadata';
import type { DocumentType } from './document-type';
import type { VerifiedFact } from './fact-contract';
import { tableContinuations, noteLinks } from './document-links';
import { compact } from './numeric-evidence';
export function standardMetric(fact: VerifiedFact): string | null {
  if (!['number', 'range'].includes(fact.kind) || fact.semantics.metricKind !== 'amount')
    return null;
  const label = compact(fact.label);
  if (/調整|コア|EBITDA/i.test(label)) return null;
  if (/^(売上高|売上収益|営業収益)$/.test(label)) return 'revenue';
  if (/^営業(?:利益|損失)(?:\(△\))?$/.test(label)) return 'operatingProfit';
  if (
    /^(?:親会社株主に帰属する|親会社の所有者に帰属する)?(?:当期|四半期|中間)?純?(?:利益|損失)(?:又は.*)?(?:\(△\))?$/.test(
      label
    )
  )
    return 'netProfit';
  return null;
}
export function verifyCoverage(
  type: DocumentType,
  allPages: ExtractedPage[],
  facts: VerifiedFact[]
): void {
  // 原文の整合性・根拠関係は全ページで検証し、必須判定はモデルの本文入力に揃える。
  const pages = allPages.filter((page) => page.selection === 'selected');
  const missing: string[] = [];
  const source = compact(pages.map((p) => p.text).join('\n'));
  if (type === 'earnings') {
    const first = pages.find((p) => p.pageNumber === 1);
    const title = first?.text
      .normalize('NFKC')
      .match(/(20\d{2}年\s*\d{1,2}月期)[^\n]*決算短信[^\n]*/);
    if (!title) throw new Error('COVERAGE:報告対象の決算期を確認できません');
    const period = compact(title[1]);
    const reportQuarter = compact(title[0]).match(/第[1-4]四半期|中間期/)?.[0];
    const expectedScope = /非連結/.test(title[0])
      ? '非連結'
      : /個別/.test(title[0])
        ? '個別'
        : /連結/.test(title[0])
          ? '連結'
          : null;
    const issuer = first?.blocks.find((b) => /上場会社名/.test(compact(b.text)))?.text;
    const expectedBasis = /日本基準/.test(title[0])
      ? '日本基準'
      : /IFRS/.test(title[0])
        ? 'IFRS'
        : null;
    const has = (metric: string, kind: string, target: string) =>
      facts.some(
        (f) =>
          standardMetric(f) === metric &&
          f.valueKind === kind &&
          compact(f.period ?? '').includes(target) &&
          (!reportQuarter ||
            kind !== 'actual' ||
            compact(f.period ?? '').includes(reportQuarter)) &&
          (!expectedScope || f.semantics.scope === expectedScope) &&
          !!f.semantics.subject &&
          (!issuer || compact(issuer).includes(compact(f.semantics.subject)))
      );
    for (const metric of ['revenue', 'operatingProfit', 'netProfit'])
      if (!has(metric, 'actual', period)) missing.push(`COVERAGE:当年決算実績の重要指標 ${metric}`);
    const forecast = source.match(/(20\d{2}年\d{1,2}月期)(?:の)?(?:通期)?(?:連結)?業績予想/);
    if (
      forecast &&
      !facts.some(
        (f) =>
          f.kind === 'status' &&
          /業績予想/.test(compact(f.quote)) &&
          /未定|非開示/.test(compact(f.quote))
      )
    ) {
      for (const metric of ['revenue', 'operatingProfit', 'netProfit'])
        if (!has(metric, 'forecast', forecast[1]))
          missing.push(`COVERAGE:通期予想の重要指標 ${metric}`);
    }
    if (
      /売上高営業利益率/.test(first?.text ?? '') &&
      !facts.some(
        (f) =>
          f.kind === 'number' &&
          /営業利益率/.test(f.label) &&
          f.semantics.metricKind === 'rate' &&
          f.valueKind === 'actual' &&
          compact(f.period ?? '') === period
      )
    )
      missing.push('COVERAGE:当年営業利益率');
    if (
      forecast &&
      /1株当たり当期純利益/.test(compact(first?.text ?? '')) &&
      !facts.some(
        (f) =>
          f.kind === 'number' &&
          /^(?:1|１)株当たり当期純利益/.test(f.label) &&
          f.semantics.metricKind === 'perShare' &&
          f.valueKind === 'forecast' &&
          compact(f.period ?? '').includes(forecast[1])
      )
    )
      missing.push('COVERAGE:通期予想の1株当たり利益');
    if (
      /配当の状況/.test(source) &&
      !facts.some(
        (f) =>
          f.kind === 'number' &&
          /配当金|期末/.test(f.label) &&
          f.semantics.metricKind === 'perShare'
      )
    )
      missing.push('COVERAGE:配当の重要事実');
    if (
      /今後の見通し/.test(source) &&
      /純損失/.test(source) &&
      /概算額/.test(source) &&
      !facts.some(
        (f) =>
          f.kind === 'event' &&
          /純損失/.test(f.statement ?? '') &&
          /概算/.test(f.quote) &&
          !!f.semantics.subject &&
          (!issuer || compact(issuer).includes(compact(f.semantics.subject))) &&
          (!expectedScope || f.semantics.scope === expectedScope) &&
          (!expectedBasis || f.semantics.basis === expectedBasis)
      )
    )
      missing.push(
        `COVERAGE:損失予想の背景・限定。本文事実にも対象会社と報告範囲=${expectedScope}を保持し、scopeIdsへ決算短信の範囲見出し ${first?.blocks.find((b) => /決算短信/.test(b.text))?.id} と会社名見出しを参照してください`
      );
    if (
      /特別損失に計上.*予定/.test(source) &&
      !facts.some(
        (f) =>
          f.kind === 'event' &&
          f.semantics.state === 'planned' &&
          /特別損失/.test(f.quote) &&
          !!f.semantics.subject &&
          (!issuer || compact(issuer).includes(compact(f.semantics.subject))) &&
          (!expectedScope || f.semantics.scope === expectedScope) &&
          (!expectedBasis || f.semantics.basis === expectedBasis)
      )
    )
      missing.push(
        `COVERAGE:損失の計上予定。原文の期間とsubject・scope=${expectedScope}・basis=${expectedBasis}を確定してください`
      );
  }
  if (type === 'earningsRevision' && /前回|修正前/.test(source) && /今回|修正後/.test(source)) {
    const report = source.match(/(20\d{2}年\d{1,2}月期)(?:通期)?(?:連結|個別)?業績予想/)?.[1];
    if (!report) throw new Error('COVERAGE:予想修正の報告対象期を確認できません');
    const issuer = pages
      .find((p) => p.pageNumber === 1)
      ?.blocks.find((b) => /会社名/.test(compact(b.text)));
    const candidates = facts.filter(
      (f) =>
        f.semantics.subject &&
        (!issuer || compact(issuer.text).includes(compact(f.semantics.subject))) &&
        f.semantics.periodKind === 'fullYear' &&
        compact(f.period ?? '').match(/^(20\d{2}年\d{1,2}月期)(?:通期)?(?:予想)?$/)?.[1] === report
    );
    for (const kind of ['forecastBefore', 'forecastAfter'])
      for (const metric of ['revenue', 'operatingProfit'])
        if (!candidates.some((f) => standardMetric(f) === metric && f.valueKind === kind))
          missing.push(`COVERAGE:予想修正の前後 ${kind}/${metric} 対象期=${report}`);
    if (/配当予想の修正/.test(source))
      for (const kind of ['forecastBefore', 'forecastAfter'])
        if (
          !candidates.some(
            (f) =>
              f.kind === 'number' &&
              /配当金|期末配当/.test(compact(f.label)) &&
              f.semantics.metricKind === 'perShare' &&
              f.valueKind === kind
          )
        )
          missing.push(
            `COVERAGE:配当予想修正の前後 ${kind} 対象期=${report}。円銭の単位見出しは円と銭を全てunitIdsで参照し、数量単位unit=円とします`
          );
  }
  if (type === 'shareRepurchase') {
    if (/上限/.test(source))
      for (const metric of ['count', 'amount'])
        if (
          !facts.some(
            (f) =>
              f.kind === 'number' &&
              f.semantics.metricKind === metric &&
              f.semantics.qualifiers.includes('上限') &&
              f.semantics.state === 'planned' &&
              f.semantics.subject
          )
        )
          missing.push(`COVERAGE:自己株取得の上限・予定 ${metric}`);
    if (
      /可能性/.test(source) &&
      !facts.some((f) => f.semantics.conditions.some((c) => /取得.*可能性/.test(compact(c))))
    )
      missing.push('COVERAGE:取得の条件');
  }
  if (type === 'businessUpdate') {
    const month = source.match(/(20\d{2}年\d{1,2}月)(?:度)?(?:の|実績|月次)/)?.[1];
    if (
      month &&
      !facts.some(
        (f) =>
          f.kind === 'number' &&
          f.semantics.periodKind === 'month' &&
          compact(f.period ?? '') === month
      )
    )
      missing.push('COVERAGE:報告対象月');
    for (const link of noteLinks(pages))
      if (
        month &&
        !facts.some(
          (f) =>
            f.kind === 'number' &&
            compact(f.label) === link.metric &&
            f.semantics.metricKind !== 'rate' &&
            compact(f.period ?? '') === month
        )
      )
        missing.push('COVERAGE:報告対象月の主要KPI');
    if (/速報値/.test(source) && !facts.some((f) => f.semantics.qualifiers.includes('速報値')))
      missing.push('COVERAGE:速報値の限定');
  }
  if (type === 'ma' && /株式.*取得|子会社化/.test(source)) {
    if (
      /決議いたしました|決議しました/.test(source) &&
      !facts.some(
        (f) =>
          f.kind === 'event' &&
          f.semantics.state === 'decided' &&
          /株式.*取得|子会社化/.test(compact(f.quote))
      )
    )
      missing.push('COVERAGE:取得の決議');
    if (
      /取得価額.*非開示/.test(source) &&
      !facts.some((f) => f.kind === 'status' && /取得価額.*非開示/.test(compact(f.quote)))
    )
      missing.push('COVERAGE:取得価額の非開示');
    if (
      /譲渡実行日/.test(source) &&
      !facts.some(
        (f) =>
          f.dateRoles?.some((d) => d.state === 'planned') && /譲渡実行日/.test(compact(f.quote))
      )
    )
      missing.push('COVERAGE:譲渡の実行予定・日付役割');
    for (const link of tableContinuations(pages)) {
      const owner = pages.find((p) => p.pageNumber === link.fromPage)!;
      const heading = owner.blocks.find((b) => link.scopeIds.includes(b.id));
      const latest = link.periodIds
        .map((id) => owner.spans.find((s) => s.id === id)!.text)
        .map(compact)
        .sort()
        .slice(-1)[0];
      for (const metric of ['revenue', 'operatingProfit', 'netProfit'])
        if (
          !facts.some(
            (f) =>
              standardMetric(f) === metric &&
              f.valueKind === 'actual' &&
              compact(f.period ?? '') === latest &&
              f.semantics.subject &&
              heading &&
              compact(heading.text).includes(compact(f.semantics.subject))
          )
        )
          missing.push(`COVERAGE:対象会社の最近の重要指標 ${metric}`);
    }
  }
  if (
    type === 'ma' &&
    /基本合意書/.test(source) &&
    !facts.some((f) => f.kind === 'event' && /基本合意書/.test(f.quote))
  )
    missing.push('COVERAGE:提携の決定事項');
  if (missing.length) throw new Error(missing.join(' / '));
}
