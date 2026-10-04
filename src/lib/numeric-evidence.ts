import {
  explicitCalendarAxisMatches,
  periodKind,
  numericValueKind,
  reportingPeriodShape,
  reportingPeriodShapes,
  reportingPeriodOwner,
} from './period-semantics';
import type { ExtractedPage } from '@/types/summaryMetadata';
import type { PdfSpan } from './pdf-layout';
import { declaredQuantityUnit, isUncaptionedUnit } from './quantity';
import {
  parseQuantity,
  parseExactRange,
  isUnitToken,
  proseQuantities,
  parseExactQuantity,
  isQuantityPrefix,
} from './quantity';
import { quantityCells, lineRuns } from './document-structure';
import { verifyQuantityAssertion } from './assertion-semantics';
import { unchangedDividendReference, quantityPeriodAxis } from './dividend-semantics';
import {
  physicalRows,
  tableUnitRuns,
  tableForValue,
  tableColumnBand,
  tableRowAxis,
  type TableRegion,
} from './table-layout';

export interface TableEvidence {
  valueId: string;
  metricIds: string[];
  periodIds: string[];
  unitIds: string[];
  contextIds: string[];
}
export interface NumericClaim {
  label: string;
  value: number | null;
  range?: boolean;
  unit: string;
  period: string;
  valueKind: string;
  subject?: string | null;
  scope?: string | null;
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

// 後続の注記でセル全体が単位候補でなくなっても、単位として読める接頭部分は残る。
// 注記を除去して単位を採用するためではなく、参照の省略を拒否するための検査。
function couldContinueUnit(unit: string, suffix: string): boolean {
  // セル全体が「注＋参照番号＋末尾区切り」の場合は独立した注記参照。
  // 末尾は閉じ括弧・閉じ引用符・句点の2文字まで。% / ·等の単位記号は含めない。
  // 単位を含む「万円注1」や、参照番号のない曖昧な「注」には適用しない。
  if (/^注\d+[\p{Pe}\p{Pf}.。]{0,2}$/u.test(suffix)) return false;
  let candidate = unit;
  for (const character of suffix) {
    candidate += character;
    if (isUnitToken(candidate)) return true;
  }
  return false;
}

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
  page: Pick<ExtractedPage, 'pageNumber' | 'text' | 'spans'> & { tableRegions?: TableRegion[] },
  raw: unknown,
  claim: NumericClaim,
  checkMeaning = true
): { evidence: TableEvidence; quote: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('参照の形式');
  const object = raw as Record<string, unknown>;
  const keys = ['valueId', 'metricIds', 'periodIds', 'unitIds', 'contextIds'];
  if (Object.keys(object).length !== keys.length || !keys.every((k) => k in object))
    fail('参照の項目');
  if (!Array.isArray(page.spans) || !page.spans.length) fail('PDFの位置情報がありません');
  const value =
    quantityCells(
      page.spans,
      page.tableRegions?.flatMap((t) => t.cells)
    ).find((s) => s.id === object.valueId) ?? fail('値の参照先・値・符号・数量の一部参照');
  const ownRow = physicalRows(page.spans).find((row) => row.some((s) => s.id === value.id));
  if (ownRow && /^(?:\(?注\)?|※)/.test(compact(ownRow.map((s) => s.text).join(''))))
    fail('注記の数量を表本体の列へ対応できません');
  const table = page.tableRegions
    ? tableForValue({ tableRegions: page.tableRegions }, value.id)
    : null;
  // Every local row/column/header search uses the same proved table membership.
  // Explicit context references remain in the document and cannot become table headers.
  const tableSpans = table ? page.spans.filter((s) => table.spanIds.includes(s.id)) : page.spans;
  const tableQuantities = quantityCells(tableSpans, table?.cells);
  const owningCells = (table?.cells ?? [])
    .filter((c) => value.spanIds.every((id) => c.spanIds.includes(id)))
    .sort(
      (a, b) => (a.right - a.left) * (a.bottom - a.top) - (b.right - b.left) * (b.bottom - b.top)
    );
  // A separator or incomplete endpoint in the same physical cell cannot be
  // silently omitted. Complete, separate quantities still retain their own IDs.
  if (
    tableSpans.some(
      (s) =>
        (owningCells[0]?.spanIds.includes(s.id) || table?.method === 'aligned') &&
        /[～〜~]/.test(s.text) &&
        isQuantityPrefix(s.text) &&
        !tableQuantities.some((q) => q.spanIds.includes(s.id))
    )
  )
    fail('数量の範囲記号・端点の断片が未解決です');
  const announcementIds = new Set(
    lineRuns(tableSpans)
      .filter((run) =>
        /20\d{2}年\d{1,2}月\d{1,2}日.*発表/.test(
          compact(
            [...run]
              .sort((a, b) => a.x - b.x)
              .map((s) => s.text)
              .join('')
          )
        )
      )
      .flatMap((run) => run.map((s) => s.id))
  );
  const parsedRange = parseExactRange(value.text);
  const parsedValue =
    claim.range && parsedRange
      ? { value: null, unit: parsedRange.unit }
      : (parseQuantity(value.text) ?? fail('値・符号'));
  if (parsedValue.value !== claim.value) fail('値・符号');
  const metrics = refs(object.metricIds, page.spans, '指標');
  const periods = refs(object.periodIds, page.spans, '期間');
  const units = refs(object.unitIds, page.spans, '単位');
  const contexts = refs(object.contextIds, page.spans, '文脈', true);
  if (table && [...metrics, ...periods, ...units].some((s) => !table.spanIds.includes(s.id)))
    fail('別の表領域の根拠');
  const selected = [value, ...metrics, ...periods, ...units, ...contexts];
  if (selected.some((s) => ![s.x, s.y, s.width, s.height].every(Number.isFinite) || s.height <= 0))
    fail('座標');
  const metricText = joined(metrics);
  const label = compact(claim.label);
  const dividend =
    (label === '年間配当金' && metricText === '年間配当金合計') ||
    (label === '期末配当金' && metricText === '年間配当金期末');
  if (metricText !== label && !dividend) fail('指標名');
  if (compact(claim.unit) === '円銭') fail('円銭の列見出しに対する数量単位は円です');
  const expectedUnit = compact(claim.unit);
  const unitIncludesValue = units.some((s) => s.id === value.id);
  const orderedUnits = units.filter((s) => s.id !== value.id).sort((a, b) => a.x - b.x);
  if (unitIncludesValue && !parsedValue.unit) fail('単位');
  if (parsedValue.unit && !unitIncludesValue) fail('値セル内の単位が未参照');
  const inlineUnit = unitIncludesValue && orderedUnits.length === 0 ? parsedValue.unit : null;
  // 値セルに含まれる単位断片も参照を必須とし、隣接セルの断片と原文順に照合する。
  const unitText = declaredQuantityUnit(
    unitIncludesValue
      ? parsedValue.unit + orderedUnits.map((s) => compact(s.text)).join('')
      : joined(units)
  );
  if (unitText === null) fail('単位宣言の形式');
  if (unitText !== expectedUnit || (unitIncludesValue && !isUnitToken(unitText!))) fail('単位');
  const adjacentUnit =
    orderedUnits.length > 0 &&
    (parsedValue.unit === null || unitIncludesValue) &&
    orderedUnits.every((s, i) => {
      const previous = i ? orderedUnits[i - 1] : value;
      const gap = s.x - previous.x - previous.width;
      return (
        sameRow(s, value) &&
        gap >= -0.5 &&
        gap <= Math.min(s.height, previous.height) * 0.6 &&
        !tableSpans.some(
          (other) =>
            other.id !== s.id &&
            other.id !== previous.id &&
            sameRow(other, value) &&
            other.x >= previous.x + previous.width &&
            other.x < s.x
        )
      );
    });
  if (inlineUnit || adjacentUnit) {
    const last = orderedUnits[orderedUnits.length - 1] ?? value;
    const omittedSuffix = tableSpans.some((s) => {
      const gap = s.x - last.x - last.width;
      return (
        !units.some((ref) => ref.id === s.id) &&
        sameRow(s, value) &&
        gap >= -0.5 &&
        gap <= Math.min(s.height, last.height) * 0.6 &&
        couldContinueUnit(unitText!, compact(s.text))
      );
    });
    if (omittedSuffix) fail('単位の続きになり得る隣接セルが未参照');
  }

  if (!isUncaptionedUnit(unitText!)) fail('数量の単位を確認できません');

  const rowNumbers = [
    ...tableQuantities,
    ...tableSpans.filter((s) => /^[－―—–-]$/.test(compact(s.text))),
  ].filter(
    (s) =>
      sameRow(s, value) &&
      !announcementIds.has(s.id) &&
      ![...metrics, ...periods, ...contexts, ...units.filter((u) => u.id !== value.id)].some(
        (ref) => ref.id === s.id
      ) &&
      (numeric(s.text) !== null || parseExactRange(s.text) || /^[－―—–-]$/.test(compact(s.text)))
  );
  const metricOnRow =
    metrics.some((s) => sameRow(s, value)) &&
    metrics.every(
      (s) => s.x + s.width <= value.x && s.y <= value.y && value.y - s.y <= s.height * 4
    );
  if (metricOnRow) {
    const left = Math.min(...metrics.map((s) => s.x)),
      right = Math.max(...metrics.map((s) => s.x + s.width));
    const quantities = tableQuantities;
    const precedingRow = Math.max(
      -Infinity,
      ...quantities
        .filter((q) => q.y < value.y && quantities.filter((other) => sameRow(q, other)).length >= 2)
        .map((q) => q.y)
    );
    const incomplete = tableSpans.some(
      (s) =>
        s.y > precedingRow &&
        s.y <= value.y &&
        value.y - s.y <= s.height * 3 &&
        s.x >= left &&
        s.x + s.width <= right &&
        !selected.some((r) => r.id === s.id) &&
        !parseQuantity(s.text) &&
        !/20\d{2}年|単位|通期|四半期|百万円|千円/.test(s.text)
    );
    if (incomplete) fail('行指標見出しの一部が未参照');
  }
  const singleValueRow = metricOnRow && rowNumbers.length === 1;
  const unitRuns = tableUnitRuns(tableSpans);
  const allUnits = unitRuns
    .map((run) => ({
      ...run[0],
      text: joined(run),
      width: run[run.length - 1].x + run[run.length - 1].width - run[0].x,
    }))
    .filter(
      (s) =>
        isUnitToken(compact(s.text)) &&
        s.y < value.y &&
        ![...metrics, ...periods, ...contexts].some((ref) => ref.id === s.id)
    );
  const groupedUnit = [...units].sort((a, b) => a.x - b.x);
  const contiguousUnit =
    unitRuns.some(
      (run) => run.length === units.length && run.every((s) => units.some((u) => u.id === s.id))
    ) ||
    groupedUnit.every(
      (s, i) =>
        !i ||
        (sameRow(s, groupedUnit[0]) &&
          s.x - groupedUnit[i - 1].x - groupedUnit[i - 1].width >= -0.5 &&
          s.x - groupedUnit[i - 1].x - groupedUnit[i - 1].width <=
            Math.min(s.height, groupedUnit[i - 1].height) * 0.6)
    );
  const localUnit =
    contiguousUnit && isUnitToken(joined(groupedUnit))
      ? {
          ...groupedUnit[0],
          text: joined(groupedUnit),
          width:
            groupedUnit[groupedUnit.length - 1].x +
            groupedUnit[groupedUnit.length - 1].width -
            groupedUnit[0].x,
        }
      : null;
  let anchors: PdfSpan[];
  let metricBand: [number, number];
  let unitY: number;
  if (inlineUnit || adjacentUnit) {
    anchors = rowNumbers;
    const band = bandFor(value, anchors, singleValueRow);
    metricBand = [band.left, band.right];
    unitY = value.y;
  } else if (localUnit) {
    const peers = [localUnit, ...allUnits.filter((s) => !units.some((u) => u.id === s.id))]
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
  const drawnBand = table
    ? tableColumnBand(
        table,
        units.map((s) => s.id),
        value.height
      )
    : null;
  if (!metricOnRow && drawnBand) metricBand = drawnBand;
  const headerHeight = Math.max(...metrics.map((s) => s.height), value.height);
  const above = (s: PdfSpan) => s.y < value.y && value.y - s.y <= headerHeight * 18;
  if (
    !metricOnRow &&
    !metrics.every((s) => {
      const run = lineRuns(tableSpans).find((run) => run.some((part) => part.id === s.id))!;
      const left = Math.min(...run.map((part) => part.x)),
        right = Math.max(...run.map((part) => part.x + part.width));
      return (
        above(s) &&
        (((left + right) / 2 > metricBand[0] && (left + right) / 2 < metricBand[1]) ||
          compact(s.text) === '年間配当金')
      );
    })
  )
    fail('指標の列');
  if (!metricOnRow) {
    const numericRowsAbove = tableSpans.filter(
      (s) =>
        s.y < unitY &&
        parseQuantity(s.text)?.unit === null &&
        tableSpans.filter((other) => sameRow(s, other) && parseQuantity(other.text)?.unit === null)
          .length >= 2
    );
    const sectionHeadings = tableSpans.filter(
      (s) =>
        s.y < unitY && /経営成績|業績|配当の状況|決算短信|財政状態|損益計算書/.test(compact(s.text))
    );
    const top = Math.max(
      unitY - headerHeight * 10,
      ...numericRowsAbove.map((s) => s.y),
      ...sectionHeadings.map((s) => s.y)
    );
    // 同じ列の見出しの一部だけを選び、潜在株式調整後等の限定を落とせない。
    const omitted = tableSpans.filter(
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
    // Inspect complete horizontal runs, so the leading digit of a neighbouring heading
    // cannot become a missing fragment of this metric. Do not discard numeric headings.
    const owned = lineRuns(tableSpans.filter((s) => s.y < unitY && s.y > top))
      .filter((run) => {
        // A complete calendar heading is a period axis, including when it wraps
        // into a financial column. Its digits are never a metric qualifier.
        const text = compact(joined(run));
        const temporal =
          /20\d{2}年/.test(text) &&
          !text.replace(/20\d{2}年\d{1,2}月(?:\d{1,2}日|期)?/g, '').replace(/[()（）～〜~-]/g, '')
            .length;
        const left = Math.min(...run.map((s) => s.x)),
          right = Math.max(...run.map((s) => s.x + s.width));
        return (
          !temporal && (left + right) / 2 > metricBand[0] && (left + right) / 2 < metricBand[1]
        );
      })
      .flat();
    const missingMetric = omitted.filter((s) => owned.some((o) => o.id === s.id));
    if (missingMetric.length)
      fail(
        `指標見出しの一部が未参照。必要=${JSON.stringify(missingMetric.map((s) => [s.id, s.text]))}`
      );
  }
  // A vertically centred row label may sit between the units and its values.
  // Bind it to one nearest numeric data row; an equal-distance tie is ambiguous.
  const dataCells = tableQuantities.filter((q) => q.y > unitY);
  const dataRows = [
    ...new Set(
      dataCells
        .filter((q) => dataCells.filter((other) => sameRow(q, other)).length >= 2)
        .map((q) => q.y)
    ),
  ];
  const onDataRow = (s: PdfSpan) => {
    if (table && tableRowAxis(table, tableSpans, value).some((axis) => axis.id === s.id))
      return true;
    if (sameRow(s, value)) return true;
    if (Math.abs(s.y - value.y) > Math.min(s.height, value.height) * 1.2) return false;
    const distances = dataRows.map((y) => Math.abs(y - s.y));
    const nearest = Math.min(...distances);
    return (
      Math.abs(value.y - s.y) <= nearest + 0.1 &&
      distances.filter((d) => Math.abs(d - nearest) < 0.1).length === 1
    );
  };
  if (!metricOnRow) {
    const axisFragments = tableSpans.filter(
      (s) =>
        onDataRow(s) &&
        s.x + s.width < Math.min(...rowNumbers.map((n) => n.x)) &&
        !physicalRows(tableSpans.filter((p) => p.x + p.width < value.x)).some(
          (run) =>
            run.some((p) => p.id === s.id) && /20\d{2}年\d{1,2}月\d{1,2}日.*発表/.test(joined(run))
        ) &&
        /予想|見込|見通し|前回|従来|修正|今回|通期|四半期|中間期|20\d{2}年/.test(compact(s.text))
    );
    if (axisFragments.some((s) => !periods.some((ref) => ref.id === s.id)))
      fail(
        `期間・区分見出しの一部が未参照。periodIdsに必要=${JSON.stringify(axisFragments.filter((s) => !periods.some((ref) => ref.id === s.id)).map((s) => [s.id, s.text]))}`
      );
  }
  const rowPeriods = periods.filter(
    (s) => onDataRow(s) && s.x + s.width < Math.min(...rowNumbers.map((n) => n.x))
  );
  const fiscalPeers = tableSpans.filter(
    (s) => s.y < value.y && /20\d{2}年\d{1,2}月期/.test(compact(s.text))
  );
  const ownedFiscal = (s: PdfSpan) => {
    const peers = fiscalPeers.filter((other) => sameRow(s, other));
    return peers.length >= 2 && peers[bandFor(value, peers).index].id === s.id;
  };
  const columnPeriods = periods.filter(
    (s) => !sameRow(s, value) && above(s) && (inBand(s) || ownedFiscal(s))
  );
  const commonPeriodIds = new Set(
    lineRuns(tableSpans)
      .filter((run) => {
        const text = joined(run);
        return (
          /20\d{2}年\d{1,2}月期/.test(text) &&
          /業績予想|経営成績/.test(text) &&
          [...text.matchAll(/20\d{2}年\d{1,2}月期/g)].length === 1 &&
          run.every((s) => above(s) && s.y < Math.min(...metrics.map((m) => m.y)))
        );
      })
      .flatMap((run) => run.map((s) => s.id))
  );
  const commonPeriods = periods.filter((s) => !rowPeriods.includes(s) && commonPeriodIds.has(s.id));
  const monthAxes = /^20\d{2}年\d{1,2}月(?:度)?$/.test(compact(claim.period));
  if (
    metricOnRow
      ? columnPeriods.filter((s) => !commonPeriodIds.has(s.id)).length + commonPeriods.length !==
        periods.length
      : monthAxes
        ? rowPeriods.length === 0 ||
          rowPeriods.length +
            columnPeriods.filter((s) => !commonPeriodIds.has(s.id)).length +
            commonPeriods.length !==
            periods.length
        : rowPeriods.length === 0 || rowPeriods.length + commonPeriods.length !== periods.length
  )
    fail(
      `期間の行・列。選んだperiodIds=${JSON.stringify(periods.map((s) => [s.id, s.text]))}。行の区分と、月次の年度列だけを参照し、表の年度タイトルはcontextIdsへ入れます`
    );
  if (
    !units.every(
      (s) =>
        (inlineUnit ? s.id === value.id : adjacentUnit || s.y < value.y) &&
        value.y - s.y < value.height * 24
    )
  )
    fail('単位の適用範囲');
  const firstHeaderY = Math.min(
    unitY,
    ...metrics.map((s) => s.y),
    ...periods.filter((s) => !commonPeriodIds.has(s.id)).map((s) => s.y)
  );
  if (
    !contexts.every(
      (s) =>
        (s.y <= firstHeaderY || rowPeriods.some((axis) => axis.id === s.id)) &&
        value.y - s.y < value.height * 32
    )
  )
    fail('文脈の適用範囲');
  // 選んだ文脈と表の間に別の決算セクションがあれば、遠い見出しは使わない。
  const section = /経営成績|連結業績|業績予想|配当の状況|財政状態|損益計算書/;
  const headings = page.spans.filter((s) => s.y < firstHeaderY && section.test(compact(s.text)));
  const nearest = headings.sort((a, b) => b.y - a.y)[0];
  if (
    !(
      nearest &&
      /経営成績|連結業績/.test(compact(nearest.text)) &&
      contexts.some((context) => context.id === nearest.id)
    ) &&
    contexts.some((context) =>
      allUnits.some(
        (unit) =>
          unit.y > context.y &&
          unit.y < firstHeaderY &&
          tableSpans.some(
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

  if (checkMeaning)
    verifyPeriodAndKind(
      claim,
      joined(periods),
      joined(contexts),
      nearest?.text ?? '',
      table !== null
    );
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

export function verifyPeriodAndKind(
  claim: NumericClaim,
  axis: string,
  context: string,
  nearest: string,
  tableCaption = false
) {
  axis = compact(quantityPeriodAxis(axis, claim.label));
  context = compact(context);
  const target = compact(claim.period),
    local = axis + context;
  // An explicit axis owns its period; a cover/context year cannot override it.
  if (!explicitCalendarAxisMatches(axis, target)) fail('対象年度・決算月の明示軸');

  const fiscal = /20\d{2}年\d{1,2}月期/;
  if (!fiscal.test(axis) && new Set(context.match(/20\d{2}年\d{1,2}月期/g) ?? []).size > 1)
    fail('対象年度・決算月の文脈が衝突しています');
  const date = /20\d{2}年\d{1,2}月\d{1,2}日/;
  const month = /20\d{2}年\d{1,2}月(?![\d期])/;
  const axisCalendarMonth = axis.match(/(\d{1,2})月(?!期)/);
  const targetCalendarMonth = target.match(/^20\d{2}年(\d{1,2})月(?:度)?$/);
  if (
    axisCalendarMonth &&
    targetCalendarMonth &&
    Number(axisCalendarMonth[1]) !== Number(targetCalendarMonth[1])
  )
    fail('対象月の行');
  const closing = (axis.match(fiscal) ?? context.match(fiscal))?.[0].match(
    /(20\d{2})年(\d{1,2})月期/
  );
  if (
    axisCalendarMonth &&
    targetCalendarMonth &&
    closing &&
    Number(target.slice(0, 4)) !==
      Number(closing[1]) - (Number(axisCalendarMonth[1]) > Number(closing[2]) ? 1 : 0)
  )
    fail('月次の年度と暦年');
  const match = target.match(fiscal)?.[0] ?? target.match(date)?.[0] ?? target.match(month)?.[0];
  if (!match) fail('対象年度・決算月');
  if (!local.includes(match!)) {
    const targetMonth = target.match(/^(20\d{2})年(\d{1,2})月$/);
    const axisMonth = axis.match(/^(\d{1,2})月$/);
    const closing = context.match(/(20\d{2})年(\d{1,2})月期/);
    if (
      !targetMonth ||
      !axisMonth ||
      !closing ||
      Number(targetMonth[2]) !== Number(axisMonth[1]) ||
      Number(targetMonth[1]) !==
        Number(closing[1]) - (Number(axisMonth[1]) > Number(closing[2]) ? 1 : 0)
    )
      fail('対象年度・決算月');
  }
  const sourceShape = reportingPeriodShape(reportingPeriodOwner(axis, context, tableCaption)),
    claimedShape = reportingPeriodShape(target);
  if (
    sourceShape &&
    sourceShape !== claimedShape &&
    !(sourceShape === '通期' && !claimedShape && fiscal.test(target))
  )
    fail('対象期間');
  if (!sourceShape && claimedShape && !(claimedShape === '通期' && fiscal.test(local)))
    fail('対象期間の根拠');
  const qualifierOwner = reportingPeriodOwner(axis, context, tableCaption);
  if (
    (/累計|中間期/.test(qualifierOwner) && /単独/.test(target)) ||
    (/単独/.test(qualifierOwner) && /累計/.test(target))
  )
    fail('累計・単独期間');
  if (/累計/.test(target) && !/累計|中間期/.test(qualifierOwner)) fail('累計期間');
  if (/単独/.test(target) && !/単独/.test(qualifierOwner)) fail('単独期間');
  // Structural obligations and accepted facts must prove a period representable
  // by the same current contract, rather than merely matching the source text.
  periodKind(claim.period, axis, context, tableCaption);
  const kind = numericValueKind(axis, context, nearest);
  if (claim.valueKind !== kind) fail('実績・予想区分');
}

/** Prose has no row/column axis: a source period overrides inherited captions. */
export function verifyProsePeriod(claim: NumericClaim, source: string, context: string): void {
  const axes = (text: string) => [
    ...new Set(compact(text).match(/20\d{2}年\d{1,2}月期|20\d{2}年\d{1,2}月(?![\d期])/g) ?? []),
  ];
  const own = axes(source);
  const applicable = own.length ? own : axes(context);
  const shapes = reportingPeriodShapes(own.length ? source : context);
  if (applicable.length > 1 || shapes.length > 1)
    throw new Error('STRUCTURE:本文数量に複数の期間があり対応を一意に証明できません');
  const target = axes(claim.period);
  if (own.length && (target.length !== 1 || target[0] !== own[0]))
    throw new Error('PERIOD:本文の明示期間と数量の期間が不一致です');
}

/** 表と本文は別の根拠形式。本文でも指標・数値・単位の直接対応だけを採用する。 */
export function verifyProseQuantity(
  page: Pick<ExtractedPage, 'pageNumber' | 'text' | 'spans'>,
  quote: string,
  claim: NumericClaim
) {
  const reference = unchangedDividendReference(quote);
  if (
    reference &&
    claim.label === '配当予想' &&
    claim.unit === '円' &&
    !claim.range &&
    Number(parseExactQuantity(reference.raw)?.decimal) === claim.value &&
    compact(page.text).includes(compact(quote))
  ) {
    const quantity = proseQuantities({ id: 'prose', text: quote }).find(
      (q) =>
        compact(q.raw) === reference.raw &&
        compact(quote.normalize('NFKC').slice(0, q.start)).length === reference.start
    );
    if (!quantity) throw new Error('QUANTITY:据置配当の原位置を確認できません');
    return quantity;
  }
  const escape = (text: string) => compact(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 複合助詞は語単位で認める。任意のひらがなは許さず、否定・概数の語を跨がない。
  const perShare = claim.unit === '円' && /配当金|1株当たり.*純利益/.test(compact(claim.label));
  const sharedDividend =
    perShare &&
    ['中間配当金', '期末配当金'].includes(compact(claim.label)) &&
    /中間配当金及び期末配当金は、?それぞれ1株当たり/.test(compact(quote));
  const labelPattern = sharedDividend ? '中間配当金及び期末配当金' : escape(claim.label);
  const bridge = `((?:について|に関して|に対して|において|として|[はがをにでと、:()]){0,6}${sharedDividend ? 'それぞれ' : ''}${perShare ? '(?:1株当たり)?' : ''})`;
  const scalar = '-?\\d+(?:\\.\\d+)?';
  const amount = claim.range
    ? `${scalar}[～〜~]${scalar}${escape(claim.unit)}`
    : `${scalar}(?:${claim.unit === '円' ? '円\\d{2}銭|' : ''}${escape(claim.unit)})`;
  const binding = new RegExp(`${labelPattern}${bridge}(${amount})(?![\\d.%/])`, 'u');
  const corresponds = (raw: string) =>
    claim.range
      ? parseExactRange(raw)?.unit === claim.unit
      : parseExactQuantity(raw)?.unit === claim.unit &&
        Number(parseExactQuantity(raw)?.decimal) === claim.value;
  // PDF paragraphs may merge consecutive numbered fields. Only a numbered
  // field at a physical line start is a new prefix boundary; a wrapped noun is not.
  const assertionText = (text: string) =>
    compact(text.normalize('NFKC').replace(/\n(?=\s*\(\d+\))/g, '；')).replace(/[△▲−](?=\d)/g, '-');
  const normalized = assertionText(quote);
  const token = '-?\\d+(?:\\.\\d+)?(?:[～〜~]-?\\d+(?:\\.\\d+)?)?';
  const heads = [...normalized.matchAll(new RegExp(`${labelPattern}${bridge}(${token})`, 'gu'))];
  if (heads.length > 1)
    throw new Error('STRUCTURE:本文の同じ指標に複数の数量があり対応を一意に証明できません');
  const match = [...normalized.matchAll(new RegExp(binding, 'gu'))].find(
    (m) =>
      m[1].replace(perShare ? /1株当たり|それぞれ/g : /$^/g, '').length <= 6 && corresponds(m[2])
  );
  if (match) {
    // Only explicit periods, resolved subject/scope and grammatical separators
    // may precede a metric. A suffix of an unproven parent metric is not proof.
    let prefix =
      normalized
        .slice(0, match.index)
        .split(/[。;；、:「」]/)
        .slice(-1)[0] ?? '';
    prefix = prefix.replace(/^\(\d+\)/, '').replace(/^\(+/, '');
    for (const owner of [claim.subject, claim.scope, '当社', '当グループ'].filter(
      (x): x is string => !!x
    ))
      prefix = prefix.replace(new RegExp(`^${escape(owner)}(?:の|は)?`), '');
    prefix = prefix.replace(
      /^20\d{2}年\d{1,2}月(?:期(?:(?:第[1-4]四半期|[1-4]Q|中間期)(?:\(?(?:累計|単独)\)?(?:期間)?)?|通期)?|\d{1,2}日|度)?(?:の|は|における)?/i,
      ''
    );
    for (const owner of [claim.subject, claim.scope].filter((x): x is string => !!x))
      prefix = prefix.replace(new RegExp(`^${escape(owner)}(?:の|は)?`), '');
    if (prefix) throw new Error('STRUCTURE:本文指標の前の限定を省略できません');
    const suffix = normalized.slice(match.index! + match[0].length);
    if (
      sharedDividend &&
      /^、年間配当金は1株当たり-?\d+(?:\.\d+)?円を予定しております。?$/.test(suffix)
    )
      verifyQuantityAssertion('を予定しております。');
    else verifyQuantityAssertion(suffix);
  }
  if (!compact(page.text).includes(compact(quote)) || !match)
    throw new Error('引用で数値・単位・指標・期間の対応を確認できません');
  const quantity = proseQuantities({ id: 'prose', text: quote }).find(
    (q) =>
      compact(q.raw).replace(/[△▲−](?=\d)/g, '-') === match[2] &&
      assertionText(quote.normalize('NFKC').slice(0, q.start)).length ===
        match.index! + match[0].length - match[2].length
  );
  if (!quantity) throw new Error('QUANTITY:本文数量の全断片を原位置で確認できません');
  // 数量セルの並ぶ行を説明文として選んで、セル参照の検証を迂回させない。
  const cells = page.spans.filter((s) =>
    claim.range ? parseExactRange(s.text) !== null : numeric(s.text) === claim.value
  );
  if (
    cells.some(
      (cell) =>
        page.spans.filter((s) => sameRow(s, cell) && numeric(s.text) !== null).length >= 2 &&
        page.spans.some((s) => sameRow(s, cell) && compact(s.text) === compact(claim.label))
    )
  )
    throw new Error('表の数値には根拠セルIDが必要です');
  return quantity;
}
export function verifyProseEvidence(
  page: Pick<ExtractedPage, 'pageNumber' | 'text' | 'spans'>,
  quote: string,
  claim: NumericClaim
): number {
  verifyProseQuantity(page, quote, claim);
  return 0;
}
