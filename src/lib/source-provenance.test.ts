import { it, expect } from 'vitest';
import { cells } from './fixtures/fact-review-source';
import { applicableSplitNotes, splitNoteApplies } from './source-provenance';

it.each(['。', '、'])('別の対象期の計算基準を混ぜず、矛盾する基準は拒否する: %s', (separator) => {
  const label = '基本的1株当たり当期利益';
  const make = (note: string) =>
    cells(
      [
        ['2027年3月期 連結経営成績', 0, 0, 250],
        ['売上高', 200, 30, 70],
        [label, 350, 30, 170],
        ['百万円', 200, 55, 70],
        ['円', 420, 55, 20],
        ['2027年3月期', 0, 80, 130],
        ['100', 200, 80, 70],
        ['10', 420, 80, 20],
        [note, 0, 115, 1200],
      ],
      1
    );
  const before = `2026年3月期の${label}は株式分割前の金額です`;
  const adjusted = `2027年3月期の${label}は株式分割を期首に行ったと仮定して算定しています`;
  const p = make(before + separator + adjusted + '。');
  const id = p.quantities.find((q) => q.text === '10')!.id;
  expect(applicableSplitNotes(p, id, label, '2026年3月期')[0].basis).toBe('beforeSplit');
  expect(applicableSplitNotes(p, id, label, '2027年3月期')[0].basis).toBe('splitAdjusted');
  const contradictory = make(before + separator + adjusted.replace('2027', '2026') + '。');
  expect(() => applicableSplitNotes(contradictory, id, label, '2026年3月期')).toThrow('適用基準');
});

it('基本・希薄化後と当期・四半期の指標を注記の明記に対応させる', () => {
  const note = '2027年3月期の基本的1株当たり当期利益は株式分割の影響を考慮しています。';
  expect(splitNoteApplies(note, '希薄化後1株当たり当期利益', '2027年3月期')).toBe(false);
  expect(splitNoteApplies(note, '1株当たり四半期利益', '2027年3月期')).toBe(false);
  expect(splitNoteApplies(note, '基本的1株当たり当期利益', '2027年3月期')).toBe(true);
});

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
  expect(
    splitNoteApplies(
      note,
      note.includes('四半期利益') ? '1株当たり四半期利益' : '基本的1株当たり当期利益',
      period
    )
  ).toBe(expected);
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
  const separated = cells(
    [
      ...p.spans
        .filter((s) => !s.text.startsWith('（注）'))
        .map((s): [string, number, number, number] => [s.text, s.x, s.y, s.width]),
      ['2. 従業員の状況', 0, 100, 200],
      [
        '（注）2027年3月期の基本的1株当たり当期利益は株式分割を期首に行ったと仮定しています。',
        0,
        115,
        900,
      ],
    ],
    1
  );
  expect(applicableSplitNotes(separated, valueId, label, '2027年3月期')).toEqual([]);
});

it('同じ注記内の配当の年度をEPSの対象期へ貸さず、未証明の複数指標を拒否する', () => {
  const eps = '2026年3月期の1株当たり当期利益は株式分割を期首に行ったと仮定して算定しています。';
  const dividend = '2027年3月期の配当は株式分割後の金額です。';
  expect(splitNoteApplies(eps + dividend, '1株当たり当期利益', '2026年3月期')).toBe(true);
  expect(splitNoteApplies(eps + dividend, '1株当たり当期利益', '2027年3月期')).toBe(false);
  expect(() =>
    splitNoteApplies(eps.replace('。', '、') + dividend, '1株当たり当期利益', '2027年3月期')
  ).toThrow('期間対応');
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
