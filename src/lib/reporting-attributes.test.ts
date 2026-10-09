import { expect, it } from 'vitest';
import {
  reportingFieldProjection,
  reportingFieldSegments,
  isReportingCoverTitle,
  reportingTargetShape,
} from './reporting-attributes';
import { declaredSubjectsIn } from './document-structure';
import { textPage } from './fixtures/v4-test-source';
import { buildDocumentContext, isReportingMetadata } from './document-context';

// Target shape is a shared declaration boundary for headline and coverage.
it.each([
  ['', { periodKind: 'fullYear' }],
  ['通期', { periodKind: 'fullYear' }],
  ['第1四半期', { quarter: '第1四半期', periodKind: 'cumulativeQ1' }],
  ['中間', { quarter: '第2四半期', periodKind: 'cumulativeQ2' }],
  ['第3四半期', { quarter: '第3四半期', periodKind: 'cumulativeQ3' }],
  ['第4四半期単独', { quarter: '第4四半期単独', periodKind: 'standaloneQ4' }],
  ['四半期', null],
  ['通期四半期', null],
  ['第4四半期', null],
  ['中間期単独', null],
  ['第1四半期第3四半期', null],
])('報告対象の%s表題を解釈し、不明な四半期や衝突を通期へ変えない', (shape, expected) => {
  const title = `2026年3月期 ${shape}決算短信〔日本基準〕（連結）`;
  expect(isReportingCoverTitle(title)).toBe(true);
  expect(reportingTargetShape(title)).toEqual(expected);
});

// Vocabulary coverage belongs here; drawing-to-headline integration has one
// representative mixed cover in source-cell-boundaries.test.ts.
it.each([
  ['上場取引所', '東'],
  ['コード番号', '464A'],
  ['証券コード', '123B'],
  ['代表者名', '(氏名) 山田 太郎'],
  ['代表者', '(役職名) 社長 (氏名) 山田 太郎'],
  ['問合せ先責任者', '(役職名) 経理部長 (氏名) 鈴木 花子'],
  ['問い合わせ先責任者', '(氏名) 鈴木 花子'],
  ['問合せ先', '経理部'],
  ['問い合わせ先', '経理部'],
  ['電話番号', '03-0000-0000'],
  ['TEL', '03-0000-0000'],
  ['URL', 'https://example.com/report%20list'],
])('管理欄も同じ構造語彙から直隣の値セルだけを投影する: %s', (label, value) => {
  const text = `${label} | ${value}`;
  expect(reportingFieldProjection(text)).toEqual({
    segments: [`${label} ${value}`],
    complete: true,
  });
  expect(isReportingMetadata({ id: 'p1b1', text })).toBe(true);
  expect(reportingFieldProjection(`${label} ││ ${value}`)).toEqual({
    // A URL remains its own complete record; the empty labelled field still
    // makes the original block incomplete and never borrows that URL.
    segments: label === 'URL' ? [label, value] : [label],
    complete: false,
  });
  expect(reportingFieldSegments(`会社名 | ${label} | ${value}`)).toEqual([
    '会社名',
    `${label} ${value}`,
  ]);
});

it('分割管理欄の表記揺れを許し、本文・値の追加セルは完全な管理欄にしない', () => {
  const text = 'コ ー ド 番 号 ： │ 464A │ u r l │ https://example.com/report%20list';
  expect(reportingFieldProjection(text)).toEqual({
    segments: ['コ ー ド 番 号 : 464A', 'u r l https://example.com/report%20list'],
    complete: true,
  });
  expect(isReportingMetadata({ id: 'p1b1', text })).toBe(true);
  for (const mixed of [
    'TEL | 03-0000-0000 売上高100百万円',
    'URL | https://example.com/report%20list | 売上高100百万円',
    'コード番号 | 464A | 参考情報',
    'TEL\n| 03-0000-0000',
  ])
    expect(isReportingMetadata({ id: 'p1b2', text: mixed })).toBe(false);
});

// Personnel records have two bounded slots. Vocabulary and rejected continuations
// live here; the mixed ruled cover owns the projection → headline integration.
it.each([
  ['代表者', '代表取締役社長', '山田太郎'],
  ['問合せ先責任者', '経理部長', '鈴木 花子'],
  ['代表者', '(役職名)', '代表取締役社長', '(氏名)', '山田太郎'],
  ['代表者名', '役職名: 社長', '氏名', '山田太郎'],
  ['代 表 者 (役職名) 社長', '(氏名) 山田 太郎'],
  ['問い合わせ先', '役職名', '財務マネージャー', '氏名: 鈴木花子'],
  ['問合せ先', '経理部長', '(担当)', '鈴木花子'],
  ['問い合わせ先責任者', '担当', '鈴木花子'],
])('同じ行の代表者・連絡先レコードを役職と氏名の範囲だけ投影する: %s', (...cells) => {
  const text = cells.join(' │ ');
  expect(reportingFieldProjection(text)).toEqual({
    segments: [cells.join(' ')],
    complete: true,
  });
  expect(isReportingMetadata({ id: 'p1b1', text })).toBe(true);
});

it('代表者・連絡先レコードの裸の追記・空欄・別行を管理欄へ取り込まない', () => {
  for (const text of [
    '代表者 │ 売上高 │ 1000',
    '代表者 │ 参考情報 │ 山田太郎',
    '代表者 │ 代表取締役社長 │ 山田太郎 │ 参考情報',
    '代表者 │ 代表取締役社長 │ 山田太郎 │ 売上高100百万円',
    '代表者 │ 代表取締役社長 │ 山田太郎。業績は好調です。',
    '代表者 ││ 代表取締役社長 │ 山田太郎',
    '代表者 │ 代表取締役社長 ││ 山田太郎',
    '代表者 │ 役職名 ││ 社長 │ 氏名 │ 山田太郎',
    '代表者 │ 代表取締役社長\n│ 山田太郎',
    '問合せ先 │ 役職名 │ 経理部長 │ 氏名\n│ 鈴木花子',
  ]) {
    expect(reportingFieldProjection(text).complete).toBe(false);
    expect(isReportingMetadata({ id: 'p1b1', text })).toBe(false);
  }
  expect(
    reportingFieldProjection('代表者 │ 代表取締役社長 │ 山田太郎 │ 会計基準 │ 日本基準')
  ).toEqual({
    segments: ['代表者 代表取締役社長 山田太郎', '会計基準 日本基準'],
    complete: true,
  });
  expect(reportingFieldProjection('代表者 │ 代表取締役社長 │ 会計基準 │ 日本基準')).toEqual({
    segments: ['代表者 代表取締役社長', '会計基準 日本基準'],
    complete: true,
  });
});

it.each(['|', '｜', '│'])('明示フィールドだけを同じ行の隣接セルへ対応させる: %s', (separator) => {
  const text = `会社名 ${separator} 株式会社テスト ${separator} 会計基準： ${separator} 日本基準 ${separator} 範囲 連結`;
  expect(reportingFieldSegments(text)).toEqual([
    '会社名 株式会社テスト',
    '会計基準: 日本基準',
    '範囲 連結',
  ]);
  expect(declaredSubjectsIn(textPage(text).blocks[0])).toEqual(['株式会社テスト']);
});

it.each(['|', '｜', '│'])('全区切りで裸の列見出しを属性へ昇格させない: %s', (separator) => {
  for (const text of [
    `第1四半期末 ${separator} 合計 ${separator}${separator} (連結)`,
    `第1四半期末 ${separator} 合計\n${separator} (連結)`,
    `参考会社 ${separator} 株式会社他社`,
  ]) {
    expect(reportingFieldSegments(text)).toEqual([]);
    const page = textPage(`${text}\n配当金は10円です。`);
    expect(buildDocumentContext([page]).bindings.flatMap((b) => b.declarations)).toEqual([]);
  }
  expect(reportingFieldSegments('(連結)')).toEqual(['(連結)']);
});

it('空欄・別ラベル・別行・任意数値をフィールド値として連結しない', () => {
  expect(reportingFieldSegments('範囲 │ │ 連結')).toEqual(['範囲']);
  expect(
    reportingFieldSegments('会社名 ││ 株式会社他社 │ 範囲 ││ 連結 │ 会計基準 日本基準')
  ).toEqual(['会社名', '範囲', '会計基準 日本基準']);
  expect(declaredSubjectsIn(textPage('会社名 ││ 株式会社他社').blocks[0])).toEqual([]);
  expect(reportingFieldSegments('範囲 │ 会計基準 │ IFRS')).toEqual(['範囲', '会計基準 IFRS']);
  expect(reportingFieldSegments('会社名 │ 会計基準 日本基準 │ 範囲 連結')).toEqual([
    '会社名',
    '会計基準 日本基準',
    '範囲 連結',
  ]);
  expect(reportingFieldSegments('範囲 │ 会計基準 日本基準')).toEqual(['範囲', '会計基準 日本基準']);
  expect(reportingFieldSegments('会社名 │ 会 計 基 準 │ 日本基準')).toEqual([
    '会社名',
    '会 計 基 準 日本基準',
  ]);
  expect(reportingFieldSegments('会社名 │ 会計基準日本基準 │ 範囲連結')).toEqual([
    '会社名',
    '会計基準日本基準',
    '範囲連結',
  ]);
  expect(reportingFieldSegments('会社名 │ コード番号 1234')).toEqual(['会社名', 'コード番号 1234']);
  expect(declaredSubjectsIn(textPage('会社名 │ 会計基準 日本基準').blocks[0])).toEqual([]);
  expect(reportingFieldSegments('会社名\n│ 株式会社テスト')).toEqual(['会社名']);
  expect(reportingFieldSegments('100 │ 20\n営業利益は△\n│ 10百万円です。')).toEqual([
    '営業利益は△',
  ]);
  expect(reportingFieldSegments('第1四半期末 │ 合計 ││ (連結)')).toEqual([]);
  expect(reportingFieldSegments('第1四半期末 │ 合計\n│ (連結)')).toEqual([]);
  expect(declaredSubjectsIn(textPage('参考会社 │ 株式会社他社').blocks[0])).toEqual([]);
  const page = textPage('取得対象株式の種類 │ 普通株式');
  expect(buildDocumentContext([page]).bindings[0].declarations).toContainEqual(
    expect.objectContaining({ role: 'scope', value: '普通株式' })
  );
  expect(page.blocks[0].text).toBe('取得対象株式の種類 │ 普通株式');
});

// Whole-record vocabulary is shared with projection, rather than permitting
// arbitrary bare table atoms. One ruled cover below owns the full integration.
it.each([
  '2026年5月10日',
  '定時株主総会開催予定日 2026年6月10日',
  '定時株主総会（継続会）開催予定日 未定',
  '配当金支払開始予定日 2026年6月10日',
  '有価証券報告書提出予定日2026年6月10日',
  '2026年5月10日 配当支払開始予定日 ―',
  '決算補足説明資料作成の有無：無',
  '決算説明会開催の有無：有（機関投資家向け）',
  'https://example.com/report%20list',
  '（百万円未満切捨て）',
  '定時株主総会（継続会）',
  '開催予定日',
  '各位',
  '以上',
])('独立した完全な管理レコードを罫線セルでも保つ: %s', (record) => {
  const normalized = record.normalize('NFKC');
  const source = `${record} │ TEL │ 03-0000-0000`;
  expect(reportingFieldProjection(source)).toEqual({
    segments: [normalized, 'TEL 03-0000-0000'],
    complete: true,
  });
  expect(isReportingMetadata({ id: 'p1b1', text: source })).toBe(true);
});

it.each([
  ['配当支払開始予定日', '2026年5月10日'],
  ['定時株主総会開催予定日', '2026年6月10日'],
  ['定時株主総会（継続会）開催予定日', '未定'],
  ['有価証券報告書提出予定日', '―'],
  ['決算説明会開催の有無', '有'],
  ['決算補足説明資料作成の有無', '無'],
])('明示した日程・状態欄は直隣の値だけを使う: %s', (label, value) => {
  const source = `${label} │ ${value}`;
  expect(reportingFieldProjection(source)).toEqual({
    segments: [`${label} ${value}`.normalize('NFKC')],
    complete: true,
  });
  expect(isReportingMetadata({ id: 'p1b1', text: source })).toBe(true);
  for (const gap of [' ││ ', '\n│ '])
    expect(isReportingMetadata({ id: 'p1b2', text: `${label}${gap}${value}` })).toBe(false);
});

it('表題と日付は独立した完全なセルとして読み、不明な追記や裸の属性を取り込まない', () => {
  const title = '2026年3月期 決算短信〔日本基準〕（連結）';
  const date = '2026年5月10日';
  for (const records of [
    [title, date],
    [date, title],
  ]) {
    expect(reportingFieldProjection(records.join(' │ '))).toEqual({
      segments: records.map((record) => record.normalize('NFKC')),
      complete: true,
    });
  }
  for (const suffix of ['参考情報', '売上高100百万円', '(個別)', 'IFRS', '有']) {
    expect(reportingFieldProjection(`${title} │ ${suffix}`)).toEqual({
      segments: [title.normalize('NFKC')],
      complete: false,
    });
    if (!suffix.startsWith('(')) expect(isReportingCoverTitle(title + suffix)).toBe(false);
    expect(isReportingMetadata({ id: 'p1b1', text: `${date}${suffix}` })).toBe(false);
  }
  for (const record of [title, date]) {
    expect(reportingFieldSegments(`会社名 │ ${record}`)).toEqual([
      '会社名',
      record.normalize('NFKC'),
    ]);
    expect(declaredSubjectsIn({ text: `会社名 │ ${record}` })).toEqual([]);
  }
});

it('表題の既存の番号・期間別名と日付の併記を完全なレコードの範囲で保つ', () => {
  for (const [prefix, shape] of [
    ['1. ', '第2四半期の'],
    ['(1) ', '中間'],
    ['■', '2Q'],
    ['', ''],
  ]) {
    const title = `${prefix}2026年3月期 ${shape}決算短信〔日本基準〕（連結）`;
    expect(isReportingCoverTitle(title)).toBe(true);
    expect(isReportingCoverTitle(`${title} 2026年5月10日`)).toBe(true);
    expect(isReportingCoverTitle(`${title} 2026年5月10日 参考情報`)).toBe(false);
  }
});
