import type { FactSemantics } from './fact-contract';
import { normalized } from './document-structure';

const passiveForecast = /見込まれ(?:る|ます|て(?:いる|います|おります))/;
const outlookForecast = /(?:となる|の)見通し(?:です|であります|である)/;
const passiveForecastNegation =
  /見込まれ(?:ません|ない|ず|て(?:おりません|いません|いない|おらず))/;
const negativePredicate = new RegExp(
  `(?:${passiveForecastNegation.source}|しておりません|しておらず|行っておりません|行っておらず|行っていません|行っていない|していません|していない|しません|行いません|行わない|行われない|ありません|ございません|未実施|未締結|ではない|ではなく|でなく|でない)`
);
// A negative forecast remains a forecast; denial of a plan cannot prove a plan.
const negative = new RegExp(`${negativePredicate.source}|に(?:は)?(?:満たない|届かない|達しない)`);
const finitePredicate = new RegExp(
  `(?:しました|します|行います|行っています|行っております|しています|しております|です|であります|でした|となりました|となっております|となります|になります|見込(?:んでおります|んでいます|みます)|${passiveForecast.source}|${outlookForecast.source}|${negativePredicate.source})`
);
const predicateEnd = new RegExp(`${finitePredicate.source}$`);
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
    if (passiveForecastNegation.test(clause)) states.add('forecast');
    const positive = clause.replace(
      new RegExp(`[^、;]*(?:${negativePredicate.source})[^、;]*`, 'g'),
      ''
    );
    if (!positive) continue;
    if (
      /予定|取得する株式|株式の取得価額|買付けの委託を行う|(?:展開|拡大|推進|検討|実施|開始|目指)(?:を)?(?:して)?(?:いきます|まいります|いたします)|進めてまいります/.test(
        positive
      )
    )
      states.add('planned');
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
