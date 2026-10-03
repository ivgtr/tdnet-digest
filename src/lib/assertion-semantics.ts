import type { FactSemantics } from './fact-contract';
import { normalized } from './document-structure';
import {
  reportingPeriodText,
  calendarIntervalSeparator,
  calendarDatePattern,
} from './period-semantics';

const passiveForecast = /見込まれ(?:る|ます|て(?:いる|います|おります))/;
const outlookForecast = /(?:となる|の)見通し(?:です|であります|である)/;
const outlookForecastNegation =
  /(?:となる|の)見通し(?:では(?:ありません|ございません|ない|なく)|で(?:ない|なく)|は(?:ありません|ございません|ない|なく))/;
const passiveForecastNegation =
  /見込まれ(?:ません|ない|ず|て(?:おりません|いません|いない|おらず))/;
const negativePredicate = new RegExp(
  `(?:${passiveForecastNegation.source}|${outlookForecastNegation.source}|できない|できません|しておりません|しておらず|行っておりません|行っておらず|行っていません|行っていない|していません|していない|しない|しません|行いません|行わない|行われない|ありません|ございません|未実施|未締結|ではない|ではなく|でなく|でない)`
);
// A negative forecast remains a forecast; denial of a plan cannot prove a plan.
const negative = new RegExp(`${negativePredicate.source}|に(?:は)?(?:満たない|届かない|達しない)`);
const finitePredicate = new RegExp(
  `(?:しました|します|行います|行っています|行っております|しています|しております|です|であります|でした|となりました|となっております|となります|になります|見込(?:んでおります|んでいます|みます)|${passiveForecast.source}|${outlookForecast.source}|${negativePredicate.source})`
);
const predicateEnd = new RegExp(`${finitePredicate.source}$`);
/** State belongs to the operative predicate, not a plan/price noun. */
export function cancelledPlan(text: string): boolean {
  return /(?:中止|撤回|取消し?|取り消)(?:(?:いた)?しました|して(?:います|おります)|(?:を|することを)(?:決定|決議)(?:いた)?しました|することと(?:いた)?しました)/.test(
    normalized(text)
  );
}
export function activePlan(text: string): boolean {
  const source = normalized(text);
  return (
    !cancelledPlan(source) &&
    new RegExp(
      `予定(?:です|であります|である|しております|しています|している)|(?:する|行う)予定[。]?$|${calendarDatePattern}(?:(?:\\d{1,2}時(?:\\d{1,2}分)?)?\\(予定\\)|(?:取得|株式譲渡|実行)予定(?!を|は|が|の))|取得する株式|買付けの委託を行う|(?:展開|拡大|推進|検討|実施|開始|目指)(?:を)?(?:して)?(?:いきます|まいります|いたします)|進めてまいります`
    ).test(source)
  );
}
/** Split proved contrasts, never parentheses or a subject followed by a comma. */
function assertionClauses(text: string): string[] {
  const source = normalized(text);
  const clauses: string[] = [];
  let start = 0,
    depth = 0;
  for (let i = 0; i < source.length; i++) {
    const replacement = source.slice(i).match(/^(?:ではなく|でなく)/)?.[0];
    if (replacement) {
      clauses.push(source.slice(start, i + replacement.length));
      i += replacement.length - 1;
      start = i + 1;
      continue;
    }
    const char = source[i];
    if ('([「『'.includes(char)) depth++;
    if (')]」』'.includes(char)) depth = Math.max(0, depth - 1);
    if (char === '。') {
      clauses.push(source.slice(start, i));
      start = i + 1;
      continue;
    }
    if (depth) continue;
    const conjunctive = source
      .slice(i)
      .match(/^(?:しておらず|行っておらず|見込まれず|見込まれておらず)/)?.[0];
    if (conjunctive) {
      const end = i + conjunctive.length;
      const rest = source.slice(end).split('。')[0];
      if (finitePredicate.test(rest) || negative.test(rest)) {
        clauses.push(source.slice(start, end));
        start = end;
        i = end - 1;
        continue;
      }
    }
    const connector = source.slice(i).match(/^(?:が、?|けれども、?|けれど、?|ものの、?|、|;)/)?.[0];
    if (!connector || !predicateEnd.test(source.slice(start, i))) continue;
    const rest = source.slice(i + connector.length).split('。')[0];
    if (!finitePredicate.test(rest) && !negative.test(rest)) continue;
    clauses.push(source.slice(start, i));
    i += connector.length - 1;
    start = i + 1;
  }
  clauses.push(source.slice(start));
  return clauses.filter(Boolean);
}
export function assertionPolarity(text: string): FactSemantics['polarity'] {
  const clauses = assertionClauses(text);
  const n = clauses.filter((c) => negative.test(c)).length;
  return n === 0 ? 'affirmative' : n === clauses.length ? 'negative' : 'mixed';
}

/** A direct quantity needs a complete supported continuation, not absence of a bad word. */
export function verifyQuantityAssertion(suffix: string): void {
  // Delimiters can enclose a modifier; they never make it a separate assertion.
  // Only a following numbered field is an independent source boundary.
  // A later sentence in the same assertion may retract this amount.
  const clause = normalized(suffix)
    .split(/[;；](?=\(\d+\))/)[0]
    .replace(/[()[\]「」『』]/g, '');
  // These are retained by sourceQualifiers and subsequently compared/displayed.
  const qualified = clause.replace(/^(?:上限|下限|概算額|概算|速報値)/, '');
  const predicate = new RegExp(
    `^(?:です|でした|であります|となりました|となっております|となります|になります|(?:の|となる)?見込み(?:です|であります)|${outlookForecast.source}|(?:を|と)見込(?:んでおります|んでいます|みます)|と${passiveForecast.source}|(?:を|と)予想(?:しております|しています)|を予定(?:しております|しています))?。?$`
  );
  if (!predicate.test(qualified))
    throw new Error(
      'STRUCTURE:数量後の否定・置換・境界・変化量または未対応の述語を確定数量へ変換できません'
    );
}
/** Proof is deliberately bounded to explicit predicates, never a role word anywhere in a heading. */
export function assertionStates(text: string): FactSemantics['state'][] {
  const states = new Set<FactSemantics['state']>();
  for (const clause of assertionClauses(text)) {
    const negations = [...clause.matchAll(new RegExp(negativePredicate.source, 'g'))];
    const lastNegative = negations[negations.length - 1];
    // The embedded negative ends at its nominal/quoted complement. Only the
    // outer predicate proves state; a negated outer predicate proves no action.
    const outer = lastNegative
      ? clause
          .slice(lastNegative.index! + lastNegative[0].length)
          .match(/^(?:ことを|ことに|方針を|と)(.+)$/)?.[1]
      : undefined;
    if (!outer && (passiveForecastNegation.test(clause) || outlookForecastNegation.test(clause)))
      states.add('forecast');
    const positive = lastNegative ? (outer ?? '') : clause;
    if (!positive) continue;
    if (!cancelledPlan(text) && activePlan(positive)) states.add('planned');
    if (
      /見込まれ|見込んで|見込み|予想して|見込め|想定して/.test(positive) ||
      new RegExp(`${outlookForecast.source}$`).test(positive)
    )
      states.add('forecast');
    if (/決議(?:いた)?しました|決定(?:いた)?しました/.test(positive)) states.add('decided');
    if (/締結(?:いた)?しました|契約を結びました/.test(positive)) states.add('contracted');
    if (/取得しました|実施しました|完了しました/.test(positive)) states.add('completed');
    // Numeric financial results use their source-role validation. An event's
    // generic となりました cannot prove realization of an action.
    if (/計上(?:して)?おります|計上しました/.test(positive)) states.add('actual');
  }
  return [...states];
}

/** A loss period must modify recording, not another assertion in the same block. */
export function lossRecordingPeriods(text: string): string[] {
  const date = calendarDatePattern;
  const interval = `${date}${calendarIntervalSeparator}${date}`;
  const period =
    '(?:翌|次|当|前)連結会計年度|20\\d{2}年\\d{1,2}月(?:期(?:第[1-4]四半期|中間期|通期)?(?:\\((?:第[1-4]四半期|中間期)\\))?(?:\\(?(?:累計|単独)\\)?)?|\\d{1,2}日|度)?';
  const recording = new RegExp(
    `(?:(${interval})(?:まで)?|(${period}))(?:に(?:おいて)?|の(?:連結)?財務諸表において|の)(?:は|、)?(?:(?:当社|当社グループ)(?:は|が))?(?:当該(?:額|費用)(?:を|は))?特別損失に計上(?:する)?予定`,
    'g'
  );
  const source = reportingPeriodText(text);
  return [
    ...new Set(
      [...source.matchAll(recording)]
        // Never reclassify the end of an unsupported interval as a point.
        .filter((m) => !/(?:[\d年月日期～〜~-]|から)$/.test(source.slice(0, m.index)))
        .map((m) => m[1] ?? m[2])
    ),
  ];
}
export function isLossRecordingPlan(text: string): boolean {
  return (
    /特別損失に計上[^。]*予定/.test(normalized(text)) &&
    assertionStates(text).length === 1 &&
    assertionStates(text)[0] === 'planned'
  );
}
export function verifyAssertionState(state: FactSemantics['state'], text: string): void {
  const states = assertionStates(text);
  if (states.length > 1)
    throw new Error(
      `STATE:段落に複数の主張状態があり単一状態を確定できません: ${states.join('/')}`
    );
  const expected = states[0] ?? 'unspecified';
  if (state !== expected)
    throw new Error(`STATE:主張の述語と状態が不一致です。原文で確定できる区分=${expected}`);
}
