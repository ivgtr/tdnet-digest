import type { ExtractedPage } from '@/types/summaryMetadata';
import type { PdfSpan } from './pdf-layout';
import { parseQuantity, isUnitToken } from './quantity';

export interface TableEvidence {
  valueId: string;
  metricIds: string[];
  periodIds: string[];
  unitIds: string[];
  contextIds: string[];
}
export interface NumericClaim {
  label: string;
  value: number;
  unit: string;
  period: string;
  valueKind: string;
}
export const compact = (text: string) => text.normalize('NFKC').replace(/[\s,，]/g, '');
const center = (s: PdfSpan) => s.x + s.width / 2;
const sameRow = (a: PdfSpan, b: PdfSpan) =>
  Math.abs(a.y - b.y) <= Math.min(a.height, b.height) * 0.3;
const numeric = (text: string) => parseQuantity(text)?.value ?? null;
const joined = (spans: PdfSpan[]) =>
  compact(
    [...spans]
      .sort((a, b) => a.y - b.y || a.x - b.x)
      .map((s) => s.text)
      .join('')
  );
const fail = (reason: string): never => {
  throw new Error(`表の根拠を確認できません: ${reason}`);
};

function refs(value: unknown, spans: PdfSpan[], name: string, empty = false): PdfSpan[] {
  if (
    !Array.isArray(value) ||
    value.length > 16 ||
    (!empty && !value.length) ||
    new Set(value).size !== value.length ||
    !value.every((id) => typeof id === 'string')
  )
    fail(`${name}の形式`);
  return (value as string[]).map(
    (id) => spans.find((s) => s.id === id) ?? fail(`${name}の参照先 ${id}`)
  );
}

export function verifyTableEvidence(
  page: ExtractedPage,
  raw: unknown,
  claim: NumericClaim
): { evidence: TableEvidence; quote: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('参照の形式');
  const object = raw as Record<string, unknown>;
  const keys = ['valueId', 'metricIds', 'periodIds', 'unitIds', 'contextIds'];
  if (Object.keys(object).length !== keys.length || !keys.every((k) => k in object))
    fail('参照の項目');
  if (!Array.isArray(page.spans) || !page.spans.length) fail('PDFの位置情報がありません');
  const value = page.spans.find((s) => s.id === object.valueId) ?? fail('値の参照先');
  if (numeric(value.text) !== claim.value) fail('値・符号');
  const metrics = refs(object.metricIds, page.spans, '指標');
  const periods = refs(object.periodIds, page.spans, '期間');
  const units = refs(object.unitIds, page.spans, '単位');
  const contexts = refs(object.contextIds, page.spans, '文脈', true);
  const selected = [value, ...metrics, ...periods, ...units, ...contexts];
  if (selected.some((s) => ![s.x, s.y, s.width, s.height].every(Number.isFinite) || s.height <= 0))
    fail('座標');
  const metricText = joined(metrics);
  const label = compact(claim.label);
  const dividend =
    (label === '年間配当金' && metricText === '年間配当金合計') ||
    (label === '期末配当金' && metricText === '年間配当金期末');
  if (metricText !== label && !dividend) fail('指標名');
  const expectedUnit = compact(claim.unit).replace(/^円銭$/, '円');
  const inlineUnit =
    units.length === 1 && units[0].id === value.id ? parseQuantity(value.text)?.unit : null;
  const unitText =
    inlineUnit ??
    joined(units)
      .replace(/^\(?単位[:：]?/, '')
      .replace(/\)$/, '')
      .replace(/^円銭$/, '円');
  if (unitText !== expectedUnit) fail('単位');

  const rowNumbers = page.spans.filter(
    (s) =>
      sameRow(s, value) &&
      ![...metrics, ...periods, ...contexts].some((ref) => ref.id === s.id) &&
      (numeric(s.text) !== null || /^[－―—–-]$/.test(compact(s.text)))
  );
  const metricOnRow = metrics.every((s) => sameRow(s, value) && s.x + s.width <= value.x);
  const singleValueRow = metricOnRow && rowNumbers.length === 1;
  const allUnits = page.spans.filter(
    (s) =>
      isUnitToken(compact(s.text)) &&
      s.y < value.y &&
      ![...metrics, ...periods, ...contexts].some((ref) => ref.id === s.id)
  );
  const localUnit = units.length === 1 && isUnitToken(compact(units[0].text)) ? units[0] : null;
  let anchors: PdfSpan[];
  let metricBand: [number, number];
  let unitY: number;
  if (inlineUnit) {
    anchors = rowNumbers;
    const band = bandFor(value, anchors, singleValueRow);
    metricBand = [band.left, band.right];
    unitY = value.y;
  } else if (localUnit) {
    const peers = allUnits
      .filter((s) => sameRow(s, localUnit))
      .sort((a, b) => center(a) - center(b));
    anchors = peers.length >= 2 ? peers : rowNumbers;
    const slot = bandFor(value, anchors, singleValueRow);
    if (
      peers.length >= 2
        ? anchors[slot.index].id !== localUnit.id
        : center(localUnit) <= slot.left || center(localUnit) >= slot.right
    )
      fail('単位の列');
    // 金額と増減率は別セル。共通の指標見出しが両者にまたがることは許す。
    const next = anchors[slot.index + 1];
    metricBand = [
      slot.left,
      next && compact(next.text) === '%' && expectedUnit !== '%'
        ? bandFor(next, anchors).right
        : slot.right,
    ];
    unitY = localUnit.y;
    if (
      allUnits.some(
        (s) =>
          s.y > unitY + value.height * 0.3 &&
          s.y < value.y &&
          center(s) > slot.left &&
          center(s) < slot.right
      )
    )
      fail('別の表の単位');
  } else {
    anchors = rowNumbers;
    const band = bandFor(value, anchors, singleValueRow);
    metricBand = [band.left, band.right];
    unitY = Math.max(...units.map((s) => s.y));
    if (!/^\(?単位[:：]/.test(joined(units))) fail('共通単位の見出し');
  }
  const inBand = (s: PdfSpan) => center(s) > metricBand[0] && center(s) < metricBand[1];
  const headerHeight = Math.max(...metrics.map((s) => s.height), value.height);
  const above = (s: PdfSpan) => s.y < value.y && value.y - s.y <= headerHeight * 18;
  if (
    !metricOnRow &&
    !metrics.every((s) => above(s) && (inBand(s) || compact(s.text) === '年間配当金'))
  )
    fail('指標の列');
  if (!metricOnRow) {
    const numericRowsAbove = page.spans.filter(
      (s) =>
        s.y < unitY &&
        parseQuantity(s.text)?.unit === null &&
        page.spans.filter((other) => sameRow(s, other) && parseQuantity(other.text)?.unit === null)
          .length >= 2
    );
    const sectionHeadings = page.spans.filter(
      (s) =>
        s.y < unitY && /経営成績|業績|配当の状況|決算短信|財政状態|損益計算書/.test(compact(s.text))
    );
    const top = Math.max(
      unitY - headerHeight * 10,
      ...numericRowsAbove.map((s) => s.y),
      ...sectionHeadings.map((s) => s.y)
    );
    // 同じ列の見出しの一部だけを選び、潜在株式調整後等の限定を落とせない。
    const omitted = page.spans.filter(
      (s) =>
        s.y < unitY &&
        s.y > top &&
        inBand(s) &&
        s.width < metricBand[1] - metricBand[0] &&
        !selected.some((ref) => ref.id === s.id) &&
        !units.some((unit) => unit.id === s.id) &&
        compact(s.text) !== expectedUnit &&
        !/経営成績|業績|配当の状況|決算短信|増減率/.test(s.text)
    );
    if (omitted.length) fail('指標見出しの一部が未参照');
  }
  if (!metricOnRow) {
    const axisFragments = page.spans.filter(
      (s) =>
        sameRow(s, value) &&
        s.x + s.width < Math.min(...rowNumbers.map((n) => n.x)) &&
        /予想|見込|見通し|前回|従来|修正|今回|通期|四半期|中間期|20\d{2}年/.test(compact(s.text))
    );
    if (axisFragments.some((s) => !periods.some((ref) => ref.id === s.id)))
      fail('期間・区分見出しの一部が未参照');
  }
  const rowPeriods = periods.filter(
    (s) => sameRow(s, value) && s.x + s.width < Math.min(...rowNumbers.map((n) => n.x))
  );
  const columnPeriods = periods.filter((s) => above(s) && inBand(s));
  if (metricOnRow ? columnPeriods.length !== periods.length : rowPeriods.length !== periods.length)
    fail('期間の行・列');
  if (
    !units.every(
      (s) => (inlineUnit ? s.id === value.id : s.y < value.y) && value.y - s.y < value.height * 24
    )
  )
    fail('単位の適用範囲');
  const firstHeaderY = Math.min(unitY, ...metrics.map((s) => s.y), ...periods.map((s) => s.y));
  if (!contexts.every((s) => s.y <= firstHeaderY && value.y - s.y < value.height * 32))
    fail('文脈の適用範囲');
  // 選んだ文脈と表の間に別の決算セクションがあれば、遠い見出しは使わない。
  const section = /経営成績|連結業績|業績予想|配当の状況|財政状態|損益計算書/;
  const headings = page.spans.filter((s) => s.y < firstHeaderY && section.test(compact(s.text)));
  const nearest = headings.sort((a, b) => b.y - a.y)[0];
  if (
    contexts.some((context) =>
      allUnits.some(
        (unit) =>
          unit.y > context.y &&
          unit.y < firstHeaderY &&
          page.spans.some(
            (cell) =>
              cell.y > unit.y &&
              cell.y < firstHeaderY &&
              numeric(cell.text) !== null &&
              Math.abs(center(cell) - center(unit)) <= unit.width / 2
          )
      )
    )
  )
    fail('別セクションの文脈');

  verifyPeriodAndKind(claim, joined(periods), joined(contexts), nearest?.text ?? '');
  const unique = [...new Map(selected.map((s) => [s.id, s])).values()].sort(
    (a, b) => a.y - b.y || a.x - b.x
  );
  return {
    evidence: {
      valueId: value.id,
      metricIds: metrics.map((s) => s.id).sort(),
      periodIds: periods.map((s) => s.id).sort(),
      unitIds: units.map((s) => s.id).sort(),
      contextIds: contexts.map((s) => s.id).sort(),
    },
    quote: unique.map((s) => s.text).join('\n'),
  };
}

function bandFor(
  value: PdfSpan,
  peers: PdfSpan[],
  singleValueRow = false
): { index: number; left: number; right: number } {
  // 指標と数量が同じ行にある単一数量表は、値の幅で列を限定する。
  // 他列から境界を推定せず、期間・単位の中央がこの領域内にあることを後段で確認する。
  if (peers.length === 1 && singleValueRow && value.width > 0) {
    return {
      index: 0,
      left: value.x - value.height / 2,
      right: value.x + value.width + value.height / 2,
    };
  }
  if (peers.length < 2) fail('表の行構造が曖昧');
  const ordered = [...peers].sort((a, b) => center(a) - center(b));
  const distances = ordered.map((s) => Math.abs(center(s) - center(value)));
  const minimum = Math.min(...distances);
  const indices = distances
    .map((d, i) => (Math.abs(d - minimum) < 0.1 ? i : -1))
    .filter((i) => i >= 0);
  if (indices.length !== 1) fail('列の境界が曖昧');
  const index = indices[0];
  const current = center(ordered[index]);
  const left = index
    ? (center(ordered[index - 1]) + current) / 2
    : current - (ordered[1] ? (center(ordered[1]) - current) / 2 : value.width);
  const right =
    index + 1 < ordered.length
      ? (current + center(ordered[index + 1])) / 2
      : current + (index ? (current - center(ordered[index - 1])) / 2 : value.width);
  if (center(value) <= left || center(value) >= right) fail('値の列範囲');
  return { index, left, right };
}

function verifyPeriodAndKind(claim: NumericClaim, axis: string, context: string, nearest: string) {
  const target = compact(claim.period);
  const yearPattern = /20\d{2}年\d{1,2}月(?:期|\d{1,2}日)/;
  const axisYear = axis.match(yearPattern)?.[0];
  const year = axisYear ?? context.match(yearPattern)?.[0];
  if (target.match(yearPattern)?.[0] !== year || !year) fail('対象年度・決算月');
  const shape = (text: string) => text.match(/第[1-4]四半期|中間期|通期/)?.[0] ?? null;
  const axisShape = shape(axis);
  if (
    axisShape &&
    axisShape !== shape(target) &&
    !(axisShape === '中間期' && shape(target) === '第2四半期')
  )
    fail('対象期間');
  if (!axisShape && shape(target) && shape(context) !== shape(target)) fail('対象期間の根拠');
  if (/累計/.test(target) && !/累計/.test(axis + context)) fail('累計期間');
  if (/単独/.test(target) && (!/単独/.test(axis + context) || /累計/.test(axis + context)))
    fail('単独期間');
  const kind = /前回|従来|修正前|直近の配当予想/.test(axis)
    ? 'forecastBefore'
    : /今回|修正後|決定額/.test(axis)
      ? 'forecastAfter'
      : /予想|見込|見通し/.test(axis) || /業績予想/.test(compact(nearest))
        ? 'forecast'
        : 'actual';
  if (claim.valueKind !== kind) fail('実績・予想区分');
}

/** 表と本文は別の根拠形式。本文でも指標・数値・単位の直接対応だけを採用する。 */
export function verifyProseEvidence(
  page: ExtractedPage,
  quote: string,
  claim: NumericClaim
): number {
  const escape = (text: string) => compact(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 助詞と句読点だけを最大6文字許容し、他の指標・数量・文を跨がない。
  const binding = new RegExp(
    `${escape(claim.label)}[はがをにでと、:()]{0,6}(-?\\d+(?:\\.\\d+)?)${escape(claim.unit)}(?![\\d.%/])`,
    'u'
  );
  const lineIndex = quote.split('\n').findIndex((line) => {
    const normalized = compact(line).replace(/[△▲](?=\d)/g, '-');
    return [...normalized.matchAll(new RegExp(binding, 'gu'))].some(
      (match) => Number(match[1]) === claim.value
    );
  });
  if (!compact(page.text).includes(compact(quote)) || lineIndex < 0)
    throw new Error('引用で数値・単位・指標・期間の対応を確認できません');
  // 数量セルの並ぶ行を説明文として選んで、セル参照の検証を迂回させない。
  const cells = page.spans.filter((s) => numeric(s.text) === claim.value);
  if (
    cells.some(
      (cell) =>
        page.spans.filter((s) => sameRow(s, cell) && numeric(s.text) !== null).length >= 2 &&
        page.spans.some((s) => sameRow(s, cell) && compact(s.text) === compact(claim.label))
    )
  )
    throw new Error('表の数値には根拠セルIDが必要です');
  return lineIndex;
}
