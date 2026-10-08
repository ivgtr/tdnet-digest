import { expect, it } from 'vitest';
import { reportingFieldSegments } from './reporting-attributes';
import { declaredSubjectsIn } from './document-structure';
import { textPage } from './fixtures/v4-test-source';
import { buildDocumentContext } from './document-context';

it.each(['|', '｜', '│'])('明示フィールドだけを同じ行の隣接セルへ対応させる: %s', (separator) => {
  const text = `会社名 ${separator} 株式会社テスト ${separator} 会計基準： ${separator} 日本基準 ${separator} 範囲 連結`;
  expect(reportingFieldSegments(text)).toEqual([
    '会社名 株式会社テスト',
    '会計基準: 日本基準',
    '範囲 連結',
  ]);
  expect(declaredSubjectsIn(textPage(text).blocks[0])).toEqual(['株式会社テスト']);
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
