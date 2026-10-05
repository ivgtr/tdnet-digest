import { it, expect } from 'vitest';
import { cells } from './fixtures/fact-review-source';
import { applicableSplitNotes, splitNoteApplies } from './source-provenance';

it.each(['。', '、', 'EPS別名', '希薄化後EPS別名'])(
  '別の対象期の計算基準を混ぜず、矛盾する基準は拒否する: %s',
  (separator) => {
    const label =
      separator === '希薄化後EPS別名' ? '希薄化後1株当たり当期利益' : '基本的1株当たり当期利益';
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
    const restated = separator.endsWith('EPS別名')
      ? adjusted.replace(label, separator === '希薄化後EPS別名' ? '希薄化後eps' : 'EPS')
      : adjusted;
    const punctuation = separator.endsWith('EPS別名') ? '、' : separator;
    const p = make(before + punctuation + restated + '。');
    const id = p.quantities.find((q) => q.text === '10')!.id;
    expect(applicableSplitNotes(p, id, label, '2026年3月期', 'actual')[0].basis).toBe(
      'beforeSplit'
    );
    expect(applicableSplitNotes(p, id, label, '2027年3月期', 'actual')[0].basis).toBe(
      'splitAdjusted'
    );
    const contradictory = make(before + punctuation + restated.replace('2027', '2026') + '。');
    expect(() => applicableSplitNotes(contradictory, id, label, '2026年3月期', 'actual')).toThrow(
      '適用基準'
    );
  }
);

it('基本・希薄化後と当期・四半期の指標を注記の明記に対応させる', () => {
  const note = '2027年3月期の基本的1株当たり当期利益は株式分割の影響を考慮しています。';
  expect(splitNoteApplies(note, '希薄化後1株当たり当期利益', '2027年3月期', 'actual')).toBe(false);
  expect(splitNoteApplies(note, '1株当たり四半期利益', '2027年3月期', 'actual')).toBe(false);
  expect(splitNoteApplies(note, '基本的1株当たり当期利益', '2027年3月期', 'actual')).toBe(true);
  // Splitting a note must not silently erase an unassigned common period declaration.
  expect(() =>
    splitNoteApplies(
      '2027年3月期について。基本的1株当たり当期利益は株式分割の影響を考慮しています。',
      '基本的1株当たり当期利益',
      '2026年3月期',
      'actual'
    )
  ).toThrow('期間対応');
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
  [
    '2026年3月期に株式分割を実施しました。基本的1株当たり当期利益は株式分割の影響を考慮して算定しています。',
    '2027年3月期',
    true,
  ],
  [
    '2026年3月期において普通株式1株につき2株の割合で株式分割を実施しました。基本的1株当たり当期利益は株式分割の影響を考慮して算定しています。',
    '2027年3月期',
    true,
  ],
  [
    '2026年3月期に当社の普通株式1株を2株に株式分割を行いました。基本的1株当たり当期利益は株式分割の影響を考慮して算定しています。',
    '2027年3月期',
    true,
  ],
  [
    '2026年3月期において基本的1株当たり当期利益は普通株式1株につき2株の割合で実施した株式分割の影響を考慮して算定しています。',
    '2027年3月期',
    false,
  ],
] as const)('EPS注記の対象期と仮定の基準日を区別する: %s / %s', (note, period, expected) => {
  expect(
    splitNoteApplies(
      note,
      note.includes('四半期利益') ? '1株当たり四半期利益' : '基本的1株当たり当期利益',
      period,
      'actual'
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
  expect(applicableSplitNotes(p, valueId, label, '2027年3月期', 'actual')).toHaveLength(1);
  expect(applicableSplitNotes(p, valueId, label, '2026年3月期', 'actual')).toEqual([]);
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
  expect(applicableSplitNotes(separated, valueId, label, '2027年3月期', 'actual')).toEqual([]);
});

it('同じ注記内の配当の年度をEPSの対象期へ貸さず、未証明の複数指標を拒否する', () => {
  const eps = '2026年3月期の1株当たり当期利益は株式分割を期首に行ったと仮定して算定しています。';
  const dividend = '2027年3月期の配当は株式分割後の金額です。';
  expect(splitNoteApplies(eps + dividend, '1株当たり当期利益', '2026年3月期', 'actual')).toBe(true);
  expect(splitNoteApplies(eps + dividend, '1株当たり当期利益', '2027年3月期', 'actual')).toBe(
    false
  );
  expect(() =>
    splitNoteApplies(
      eps.replace('。', '、') + dividend,
      '1株当たり当期利益',
      '2027年3月期',
      'actual'
    )
  ).toThrow('期間対応');
});

it.each([
  '基本的1株当たり当期利益',
  '1株当たり四半期利益',
  '1株当たり中間損失',
  '希薄化後1株当たり当期利益',
  'EPS',
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
  const noteMetric = label === 'EPS' ? '基本的1株当たり当期利益' : label;
  const p = make(
    `${label === 'EPS' ? '2025年3月期に株式分割を実施しました。' : ''}株式分割を期首に行ったと仮定して${noteMetric}を算定しています。`
  );
  const q = p.quantities.find((q) => q.text === '10')!;
  expect(applicableSplitNotes(p, q.id, label, '2026年3月期', 'actual')).toEqual([
    expect.objectContaining({ basis: 'splitAdjusted', text: expect.stringContaining(noteMetric) }),
  ]);
  expect(applicableSplitNotes(p, q.id, '売上高', '2026年3月期', 'actual')).toEqual([]);
  const unresolved = make(`株式分割と${label}については別途記載しています。`);
  expect(() =>
    applicableSplitNotes(
      unresolved,
      unresolved.quantities.find((q) => q.text === '10')!.id,
      label,
      '2026年3月期',
      'actual'
    )
  ).toThrow('適用基準');
});

it('配当の分割注記を対象年度・配当区分へ限定し、矛盾や未解決を拒否する', () => {
  const make = (note: string) =>
    cells(
      [
        ['2027年3月期 配当の状況', 0, 0, 250],
        ['売上高', 200, 30, 70],
        ['年間配当金期末', 350, 30, 170],
        ['百万円', 200, 55, 70],
        ['円', 420, 55, 20],
        ['2026年3月期', 0, 80, 130],
        ['100', 200, 80, 70],
        ['10', 420, 80, 20],
        ['2027年3月期', 0, 105, 130],
        ['200', 200, 105, 70],
        ['20', 420, 105, 20],
        [note, 0, 140, 1200],
      ],
      1
    );
  const text = '2027年3月期期末については、株式分割後の配当金の金額を記載しています。';
  const p = make(
      text +
        'なお、株式分割を考慮しない場合の2027年3月期(予想)の1株当たり期末配当金は20円となります。'
    ),
    id = p.quantities.find((q) => q.text === '10')!.id;
  expect(applicableSplitNotes(p, id, '年間配当金期末', '2026年3月期', 'actual')).toEqual([]);
  expect(applicableSplitNotes(p, id, '年間配当金第2四半期末', '2027年3月期', 'actual')).toEqual([]);
  expect(applicableSplitNotes(p, id, '年間配当金合計', '2027年3月期', 'actual')).toEqual([]);
  expect(applicableSplitNotes(p, id, '年間配当金期末', '2027年3月期', 'actual')).toEqual([
    expect.objectContaining({ basis: 'afterSplit' }),
  ]);
  const mixed = make(
    '2026年3月期及び2027年3月期第2四半期末については株式分割前の配当金です。' + text
  );
  expect(applicableSplitNotes(mixed, id, '年間配当金期末', '2026年3月期', 'actual')[0].basis).toBe(
    'beforeSplit'
  );
  expect(
    applicableSplitNotes(mixed, id, '年間配当金第2四半期末', '2027年3月期', 'actual')[0].basis
  ).toBe('beforeSplit');
  const contradictory = make(text + text.replace('分割後', '分割前'));
  expect(() =>
    applicableSplitNotes(contradictory, id, '年間配当金期末', '2027年3月期', 'actual')
  ).toThrow('適用基準');
  const unresolved = make('株式分割と配当金については別途記載しています。');
  expect(() =>
    applicableSplitNotes(unresolved, id, '年間配当金期末', '2027年3月期', 'actual')
  ).toThrow('適用基準');
});

it.each(['。', '、'])(
  '配当注記の年度ごとの述語を混ぜず、年度だけの全配当宣言を認識する: %s',
  (separator) => {
    const note =
      '2026年3月期については株式分割前の配当金です' +
      separator +
      '2027年3月期期末については株式分割後の金額です。';
    const p = cells(
        [
          ['配当の状況', 0, 0, 200],
          ['売上高', 150, 30, 70],
          ['年間配当金期末', 300, 30, 140],
          ['百万円', 150, 55, 70],
          ['円', 350, 55, 30],
          ['2026年3月期', 0, 80, 130],
          ['100', 150, 80, 70],
          ['10', 350, 80, 30],
          [note, 0, 115, 1200],
        ],
        1
      ),
      id = p.quantities.find((q) => q.text === '10')!.id;
    expect(applicableSplitNotes(p, id, '年間配当金期末', '2026年3月期', 'actual')[0].basis).toBe(
      'beforeSplit'
    );
    expect(applicableSplitNotes(p, id, '年間配当金期末', '2027年3月期', 'actual')[0].basis).toBe(
      'afterSplit'
    );
    expect(() =>
      splitNoteApplies(
        '2026年3月期のEPSと2027年3月期の配当金は株式分割後の金額です。',
        '年間配当金期末',
        '2026年3月期',
        'actual'
      )
    ).toThrow('期間対応');
  }
);

it.each(['(予想)', '(実績)', '(予想)の', '(実績)の'])(
  '配当区分を状態の括弧で失わず期末以外へ渡さない: %s',
  (qualifier) => {
    const note = `2027年3月期${qualifier}期末配当金については株式分割後の金額です。`;
    expect(
      splitNoteApplies(
        note,
        '年間配当金期末',
        '2027年3月期',
        qualifier.includes('予想') ? 'forecast' : 'actual'
      )
    ).toBe(true);
    expect(
      splitNoteApplies(
        note,
        '年間配当金第2四半期末',
        '2027年3月期',
        qualifier.includes('予想') ? 'forecast' : 'actual'
      )
    ).toBe(false);
    expect(
      splitNoteApplies(
        note,
        '年間配当金合計',
        '2027年3月期',
        qualifier.includes('予想') ? 'forecast' : 'actual'
      )
    ).toBe(false);
  }
);
it.each([
  '(第2四半期累計)',
  '第2四半期(累計)',
  '(第2四半期)(累計)',
  '(中間期)',
  '(2Q単独)',
  'の(第2四半期累計)',
])('EPS注記の括弧内の形・累計単独を対象期間に保持する: %s', (shape) => {
  const note = `2027年3月期${shape}の1株当たり四半期利益は株式分割の影響を考慮しています。`;
  const target = shape.includes('単独') ? '2027年3月期第2四半期単独' : '2027年3月期第2四半期累計';
  expect(splitNoteApplies(note, '1株当たり四半期利益', target, 'actual')).toBe(true);
  expect(
    splitNoteApplies(
      note,
      '1株当たり四半期利益',
      target.replace(
        shape.includes('単独') ? '単独' : '累計',
        shape.includes('単独') ? '累計' : '単独'
      ),
      'actual'
    )
  ).toBe(false);
  expect(splitNoteApplies(note, '1株当たり四半期利益', '2027年3月期第3四半期累計', 'actual')).toBe(
    false
  );
  const restated =
    note.replace('。', '、') +
    `2027年3月期(第3四半期累計)の1株当たり四半期利益は株式分割前の金額です。`;
  expect(splitNoteApplies(restated, '1株当たり四半期利益', target, 'actual')).toBe(true);
});

it.each(['(第5四半期累計)', '(第2四半期累計単独)', '(予想)(実績)', '(未定)'])(
  '未証明・矛盾した括弧の限定を年次の注記として扱わない: %s',
  (qualifier) => {
    expect(() =>
      splitNoteApplies(
        `2027年3月期${qualifier}のEPSは株式分割の影響を考慮しています。`,
        'EPS',
        '2027年3月期',
        'actual'
      )
    ).toThrow('期間限定');
  }
);

it.each(['年間配当金期末', '基本的1株当たり当期利益'])(
  '同年度でも予想・実績の注記を異なる状態へ貸さない: %s',
  (label) => {
    const subject = /配当/.test(label) ? '期末配当金' : label;
    for (const [qualifier, states] of [
      ['予想', ['forecast', 'forecastBefore', 'forecastAfter']],
      ['実績', ['actual']],
    ] as const) {
      const note = `2027年3月期(${qualifier})の${subject}は株式分割後の金額です。`;
      for (const state of ['actual', 'forecast', 'forecastBefore', 'forecastAfter', null] as const)
        expect(splitNoteApplies(note, label, '2027年3月期', state)).toBe(
          (states as readonly (string | null)[]).includes(state)
        );
      expect(
        splitNoteApplies(
          `2027年3月期の${subject}は株式分割後の金額です。`,
          label,
          '2027年3月期',
          'actual'
        )
      ).toBe(true);
    }
  }
);

it.each(['EPS(予想)', '2027年3月期のEPS(予想)', '2027年3月期の期末配当金(実績)'])(
  '所属できない注記の状態限定を無視しない: %s',
  (subject) =>
    expect(() =>
      splitNoteApplies(
        `${subject}は株式分割後の金額です。`,
        subject.includes('配当') ? '年間配当金期末' : 'EPS',
        '2027年3月期',
        'actual'
      )
    ).toThrow('状態限定')
);
