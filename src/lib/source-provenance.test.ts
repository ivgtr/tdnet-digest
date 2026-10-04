import { it, expect } from 'vitest';
import { cells } from './fixtures/fact-review-source';
import { applicableSplitNotes, splitNoteApplies } from './source-provenance';

it.each([
  [
    '2026年3月期及び2027年3月期の基本的1株当たり当期利益を株式分割の影響を考慮して算定しています。',
    '2027年3月期',
    true,
  ],
  [
    '2026年3月期及び2027年3月期の基本的1株当たり当期利益を株式分割の影響を考慮して算定しています。',
    '2025年3月期',
    false,
  ],
  [
    '2027年3月期第3四半期累計の1株当たり四半期利益を株式分割の影響を考慮して算定しています。',
    '2027年3月期第3四半期単独',
    false,
  ],
  [
    '2027年3月期第3四半期累計の1株当たり四半期利益を株式分割の影響を考慮して算定しています。',
    '2027年3月期第3四半期累計',
    true,
  ],
  [
    '2026年3月期の期首に株式分割を行ったと仮定して1株当たり当期利益を算定しています。',
    '2027年3月期',
    true,
  ],
] as const)('EPS注記の対象期と仮定の基準日を区別する: %s / %s', (note, period, expected) => {
  expect(splitNoteApplies(note, '基本的1株当たり当期利益', period)).toBe(expected);
});

it('EPSの分割調整は注記が明示した対象期だけに適用する', () => {
  const label = '基本的1株当たり当期利益';
  const p = cells(
    [
      ['2027年3月期 連結経営成績', 0, 0, 250],
      ['売上高', 200, 30, 70],
      [label, 350, 30, 170],
      ['百万円', 200, 55, 70],
      ['円', 420, 55, 20],
      ['2027年3月期', 0, 80, 130],
      ['100', 200, 80, 70],
      ['10', 420, 80, 20],
      [
        `（注）2027年3月期の${label}は、株式分割を期首に行ったと仮定して算定しています。`,
        0,
        115,
        850,
      ],
    ],
    1
  );
  const valueId = p.quantities.find((q) => q.text === '10')!.id;
  expect(applicableSplitNotes(p, valueId, label, '2027年3月期')).toHaveLength(1);
  expect(applicableSplitNotes(p, valueId, label, '2026年3月期')).toEqual([]);
});

it.each([
  '基本的1株当たり当期利益',
  '1株当たり四半期利益',
  '1株当たり中間損失',
  '希薄化後1株当たり当期利益',
])('純のないEPS注記も適用し、未解決の基準を黙って落とさない: %s', (label) => {
  const make = (note: string) =>
    cells(
      [
        ['2026年3月期 連結経営成績', 0, 0, 250],
        ['売上高', 200, 30, 70],
        [label, 350, 30, 170],
        ['百万円', 200, 55, 70],
        ['円', 420, 55, 20],
        ['2026年3月期', 0, 80, 130],
        ['100', 200, 80, 70],
        ['10', 420, 80, 20],
        [note, 0, 115, 650],
      ],
      1
    );
  const p = make(`株式分割を期首に行ったと仮定して${label}を算定しています。`);
  const q = p.quantities.find((q) => q.text === '10')!;
  expect(applicableSplitNotes(p, q.id, label, '2026年3月期')).toEqual([
    expect.objectContaining({ basis: 'splitAdjusted', text: expect.stringContaining(label) }),
  ]);
  expect(applicableSplitNotes(p, q.id, '売上高', '2026年3月期')).toEqual([]);
  const unresolved = make(`株式分割と${label}については別途記載しています。`);
  expect(() =>
    applicableSplitNotes(
      unresolved,
      unresolved.quantities.find((q) => q.text === '10')!.id,
      label,
      '2026年3月期'
    )
  ).toThrow('適用基準');
});
