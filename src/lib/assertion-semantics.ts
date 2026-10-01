import type { FactSemantics } from './fact-contract';
import { normalized } from './document-structure';

const negative =
  /していません|していない|しません|行わない|行われない|ありません|ございません|未実施|未締結/;
export function assertionPolarity(text: string): FactSemantics['polarity'] {
  const clauses = text
    .split(/[。()（）]/)
    .map(normalized)
    .filter(Boolean);
  const n = clauses.filter((c) => negative.test(c)).length;
  return n === 0 ? 'affirmative' : n === clauses.length ? 'negative' : 'mixed';
}
/** Proof is deliberately bounded to explicit predicates, never a role word anywhere in a heading. */
export function assertionStates(text: string): FactSemantics['state'][] {
  const states = new Set<FactSemantics['state']>();
  for (const clause of text
    .split(/[。\n]/)
    .map(normalized)
    .filter(Boolean)) {
    const positive = clause.replace(
      /[^、；]*(?:していません|していない|しません|行わない|行われない|ありません|ございません|未実施|未締結)[^、；]*/g,
      ''
    );
    if (!positive) continue;
    if (
      /予定|取得する株式|株式の取得価額|買付けの委託を行う|(?:展開|拡大|推進|検討|実施|開始|目指)(?:を)?(?:して)?(?:いきます|まいります|いたします)|進めてまいります/.test(
        positive
      )
    )
      states.add('planned');
    if (/見込まれ|見込んで|見込み|予想して|見込め|想定して/.test(positive)) states.add('forecast');
    if (/決議(?:いた)?しました|決定(?:いた)?しました/.test(positive)) states.add('decided');
    if (/締結(?:いた)?しました|契約を結びました/.test(positive)) states.add('contracted');
    if (/取得しました|実施しました|完了しました/.test(positive)) states.add('completed');
    if (
      /計上(?:して)?おります|計上しました|(?<!予定)(?<!見込)(?<!見込み)となりました/.test(positive)
    )
      states.add('actual');
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
