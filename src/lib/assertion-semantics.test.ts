import { describe, expect, it } from 'vitest';
import {
  assertionPolarity,
  assertionStates,
  assertionKinds,
  verifyQuantityAssertion,
} from './assertion-semantics';

// 語尾の分岐はここで確認し、候補→修復→保存の各経路へ総当たりで複製しない。
describe('述語が証明する状態・極性・確定数量', () => {
  it.each([
    '取得価額は非開示です。',
    '取得時期は未定です。',
    '該当なし',
    '該当事項はございません。',
  ])('明示の開示状態だけstatusを許す: %s', (text) => {
    expect(assertionKinds(text)).toEqual(['event', 'status']);
  });
  it.each([
    'と見込まれます。',
    'と見込まれる',
    'と見込まれております。',
    'と見込まれています。',
    'と見込まれている。',
    'となる見通しです。',
    'となる見通しであります。',
    'となる見通しである。',
  ])('完結する予想述語: %s', (suffix) => {
    expect(assertionStates(`売上高は100百万円${suffix}`)).toEqual(['forecast']);
    expect(assertionPolarity(`売上高は100百万円${suffix}`)).toBe('affirmative');
    expect(() => verifyQuantityAssertion(suffix)).not.toThrow();
  });

  it.each([
    'とは見込まれません。',
    'と見込まれない。',
    'と見込まれず。',
    'と見込まれておりません。',
    'と見込まれていません。',
    'と見込まれていない。',
    'と見込まれておらず。',
    'となる見通しではありません。',
    'となる見通しではございません。',
    'となる見通しではない。',
    'となる見通しでない。',
    'となる見通しはありません。',
    'となる見通しはございません。',
    'となる見通しはない。',
    'となる見通しはなく。',
  ])('否定された予想は確定額を証明しない: %s', (suffix) => {
    expect(assertionStates(`売上高は100百万円${suffix}`)).toEqual(['forecast']);
    expect(assertionPolarity(`売上高は100百万円${suffix}`)).toBe('negative');
    expect(() => verifyQuantityAssertion(suffix)).toThrow('数量後');
  });

  it.each([
    'と見込まれますが確定していません。',
    'と見込まれます。実際には100百万円に届かない見込みです。',
    'と見込まれますではなく200百万円です。',
    'と見込まれるとは限りません。',
    'と見込まれるものの確定していません。',
  ])('予想述語の後の撤回・置換・不確定を読み飛ばさない: %s', (suffix) => {
    expect(() => verifyQuantityAssertion(suffix)).toThrow('数量後');
  });

  it.each([
    ['当社は取得を実施いたしません。', 'negative', []],
    ['当社は、取得を予定していません。', 'negative', []],
    ['当社は取得予定の変更を行いません。', 'negative', []],
    ['当社は（自己株式の）取得を行いません。', 'negative', []],
    ['当社は取得を行っていない。', 'negative', []],
    ['当社は取得を行っておらず、今後も取得を予定しておりません。', 'negative', []],
    ['当社はAを取得しましたが、Bは取得していません。', 'mixed', ['completed']],
    ['当社はAを取得しました、Bは取得していません。', 'mixed', ['completed']],
    ['当社はAの取得を行わない、別案件を取得しました。', 'mixed', ['completed']],
    ['当社はAを取得しておらず別案件を取得しました。', 'mixed', ['completed']],
    ['当社はAの取得を実施しますがBの取得は実施しません。', 'mixed', []],
    ['当社はAの取得を行っていますがBの取得は行っていません。', 'mixed', []],
    ['当社はAの取得を行っておりますがBの取得は行っておりません。', 'mixed', []],
    ['売上高は100百万円と見込まれておらず200百万円と見込まれます。', 'mixed', ['forecast']],
    ['業績への影響は見込めない。', 'negative', ['forecast']],
    ['業績への影響は見込めていません。', 'negative', ['forecast']],
  ] as const)('括弧・名詞・接続と述語を区別する: %s', (body, polarity, states) => {
    expect(assertionPolarity(body)).toBe(polarity);
    expect(assertionStates(body)).toEqual(states);
  });
});
