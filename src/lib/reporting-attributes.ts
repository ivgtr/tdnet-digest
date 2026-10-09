import {
  calendarDatePattern,
  REPORTING_PERIOD_SHAPE_PATTERN,
  reportingPeriodShapes,
  reportingPeriodText,
} from './period-semantics';
import type { FactPeriodKind } from './fact-contract';
import { isUncaptionedUnit, parseExactNumeric, proseQuantities } from './quantity';

/** Source vocabulary shared by reporting declarations and their consumers. */
export const reportingScope = '非連結|個別|単体|連結';
export const reportingBasis = '日本基準|IFRS(?:会計基準)?|国際会計基準|米国基準';

/** A reporting declaration may imply annual only when it does not declare an unknown quarter. */
export function reportingTargetShape(
  text: string
): { quarter?: string; periodKind: FactPeriodKind } | null {
  const normalized = reportingPeriodText(text);
  const shapes = reportingPeriodShapes(normalized);
  if (shapes.length > 1 || (/累計|中間期/.test(normalized) && /単独/.test(normalized))) return null;
  const quarter = shapes[0]?.match(/第([1-4])四半期/)?.[1];
  if (!quarter) return /四半期/.test(normalized) ? null : { periodKind: 'fullYear' };
  const standalone = /単独/.test(normalized);
  if (quarter === '4' && !standalone) return null;
  return {
    quarter: `第${quarter}四半期${standalone ? '単独' : ''}`,
    periodKind: `${standalone ? 'standalone' : 'cumulative'}Q${quarter}` as FactPeriodKind,
  };
}

/** Read paired source brackets without assigning meaning to an absent capture. */
export function bracketedReportingBases(text: string): string[] {
  return [
    ...text
      .normalize('NFKC')
      .replace(/\s/g, '')
      .matchAll(new RegExp(`〔(${reportingBasis})〕|\\[(${reportingBasis})\\]`, 'gi')),
  ].map((match) => match[1] ?? match[2]);
}

/** Compare supported aliases; source declarations and verified facts keep their wording. */
export function reportingAttributeKey(role: 'subject' | 'scope' | 'basis', value: string): string {
  const text = value.normalize('NFKC').replace(/\s/g, '');
  if (role === 'scope' && /^(?:個別|単体|非連結)$/.test(text)) return '非連結';
  if (role === 'basis' && /^(?:IFRS(?:会計基準)?|国際会計基準)$/i.test(text)) return 'IFRS';
  return text;
}

// Use the same vocabulary for complete administrative fields and structural
// label/value pairing, so a recognized label cannot strand its adjacent value.
const personnelFieldLabels = [
  '代表者名',
  '代表者',
  '問合せ先責任者',
  '問い合わせ先責任者',
  '問合せ先',
  '問い合わせ先',
];
const administrativeFieldLabels = [
  '上場取引所',
  'コード番号',
  '証券コード',
  ...personnelFieldLabels,
  '電話番号',
  'TEL',
  'URL',
];
const scheduleLabels = [
  '定時株主総会(?:\\(継続会\\))?開催予定日',
  '配当(?:金)?支払開始予定日',
  '有価証券報告書提出予定日',
];
const statusLabel = '決算(?:補足説明資料作成|説明会開催)の有無';
const fieldLabels = `上場会社名|会社名|名称|範囲|会計基準|株式種類|取得対象株式(?:の)?種類|${administrativeFieldLabels.join('|')}|${scheduleLabels.join('|')}|${statusLabel}`;
const fieldName = new RegExp(`^(?:${fieldLabels}):?$`, 'i');
const fieldStart = new RegExp(`^(?:${fieldLabels})`, 'i');
const fieldLabelText = (part: string) =>
  part.replace(/\s/g, '').replace(/^(?:\(\d+\)|\d+[.．])/, '');
const spacedLabels = (labels: string[]) => labels.map((label) => [...label].join('\\s*')).join('|');

/** Spacing between label glyphs is layout, but a field still needs a value delimiter. */
const administrativeField = new RegExp(
  `^(${spacedLabels(administrativeFieldLabels)})(?=\\s|:|$)[\\s:]*(.*)$`,
  'i'
);
const nextAdministrativeField = new RegExp(
  `\\s+(?=(?:${spacedLabels(administrativeFieldLabels)})(?=\\s|:|$)|\\(T\\s*E\\s*L\\))`,
  'i'
);
const securitiesCode = /^[0-9][0-9A-Z][0-9][0-9A-Z]$/i;
const telephone = /^\+?\d+(?:[-‐‑−–—ー]\d+)*$/;
const exchange =
  /^(?:(?:東|名|福|札)(?:証)?|(?:東京|名古屋|福岡|札幌)(?:証券取引所)?)(?:[・、,/]?(?:(?:東|名|福|札)(?:証)?|(?:東京|名古屋|福岡|札幌)(?:証券取引所)?))*$/;

function isReportingUrl(value: string): boolean {
  if (!/^https?:\/\/[^\s|│]+$/i.test(value)) return false;
  try {
    return !!new URL(value).hostname;
  } catch {
    return false;
  }
}

function isReportingTelephone(value: string): boolean {
  // Separators and a parenthesized area/exchange code are presentation. Require
  // balanced numeric groups and a complete domestic or international digit count.
  if (/[()]/.test(value.replace(/\(\d+\)/g, ''))) return false;
  const number = value.replace(/[()]/g, '');
  if (!telephone.test(number)) return false;
  const digits = number.replace(/\D/g, '');
  return number.startsWith('+') ? /^[1-9]\d{9,14}$/.test(digits) : /^0\d{9,10}$/.test(digits);
}

function administrativeValue(label: string, value: string): boolean {
  const compact = value.replace(/\s/g, '');
  switch (label.replace(/\s/g, '').toUpperCase()) {
    case 'コード番号':
    case '証券コード':
      return securitiesCode.test(compact);
    case 'URL':
      return isReportingUrl(value);
    case 'TEL':
    case '電話番号':
      return isReportingTelephone(compact);
    case '上場取引所':
      return exchange.test(compact);
    default:
      return isPersonnelFieldValue(value, /問.*合.*せ.*先/.test(label));
  }
}

export function isReportingAdministrativeField(text: string): boolean {
  const raw = text.normalize('NFKC').trim();
  if (/[\n|│]/.test(raw)) return false;
  const field = raw.match(administrativeField);
  if (!field) return false;
  // Complete adjacent records (code + URL, contact + TEL) share the same
  // per-field proof. An unknown or empty suffix cannot hide behind the first label.
  const next = field[2].search(nextAdministrativeField);
  const value = next < 0 ? field[2] : field[2].slice(0, next);
  const rest =
    next < 0
      ? ''
      : field[2]
          .slice(next)
          .trim()
          .replace(/^\(T\s*E\s*L\)/i, 'TEL ');
  return administrativeValue(field[1], value) && (!rest || isReportingAdministrativeField(rest));
}

/** A company field may share a record with admin fields, but cannot validate them. */
function hasInvalidAdministrativeField(text: string): boolean {
  const raw = text.normalize('NFKC').trim();
  const start = administrativeField.test(raw) ? 0 : raw.search(nextAdministrativeField);
  return (
    start >= 0 &&
    !isReportingAdministrativeField(
      raw
        .slice(start)
        .trim()
        .replace(/^\(T\s*E\s*L\)/i, 'TEL ')
    )
  );
}

// Complete records are shared by ruled-cell projection and cover consumers.
// Scope/basis/company atoms are deliberately absent: their ownership needs a
// named field or an independently supported unruled declaration.
const compactReportingText = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
const coverTitlePrefix = `(?:${calendarDatePattern})?(?:20\\d{2}年\\d{1,2}月期(?:の)?)?(?:(?:${REPORTING_PERIOD_SHAPE_PATTERN})+(?:の)?)?(?:四半期)?決算短信`;
const coverTitleStart = new RegExp(`^${coverTitlePrefix}`, 'i');
const coverTitle = new RegExp(
  `^${coverTitlePrefix}(?:(?:〔(?:${reportingBasis})〕|\\[(?:${reportingBasis})\\])|\\((?:${reportingScope})\\))*(?:の(?:一部訂正について|補足説明資料))?(?:${calendarDatePattern})?$`,
  'i'
);
const coverRecordText = (text: string) =>
  reportingPeriodText(text).replace(/^(?:\(\d+\)|\d+[.．]|■)/, '');
export function isReportingCoverTitle(text: string): boolean {
  return coverTitle.test(coverRecordText(text));
}
/** A malformed cover must still use the strict earnings ownership boundary. */
export function hasReportingCoverTitle(text: string): boolean {
  return text
    .normalize('NFKC')
    .split(/[\n|│]/)
    .some((cell) => coverTitleStart.test(coverRecordText(cell)));
}

const monetaryUnit = '(?:十|百|千|万|百万|千万|億|兆)?(?:円|%)';
const reportingAmount = new RegExp(
  `[0-9][0-9,.]*${monetaryUnit}|${monetaryUnit}(?:[):]|\\]|】)*[△▲−-]?[0-9]`
);
export function reportingValueText(text: string): boolean {
  const raw = text.normalize('NFKC').trim();
  // Complete URL/code fields are literal metadata: encoded paths are not percentages
  // and the letter in a four-character securities code is not a quantity unit.
  if (
    /^(?:U\s*R\s*L(?:\s*:\s*|\s+))?https?:\/\/\S+$/i.test(raw) ||
    /^(?:コ\s*ー\s*ド\s*番\s*号|証\s*券\s*コ\s*ー\s*ド)(?:\s*:\s*|\s+)[0-9A-Z]{4}(?:\s+U\s*R\s*L(?:\s*:\s*|\s+)https?:\/\/\S+)?$/i.test(
      raw
    )
  )
    return false;
  return (
    /[。；;]/.test(raw) ||
    reportingAmount.test(compactReportingText(raw)) ||
    proseQuantities({ id: 'metadata', text: raw }).some((quantity) =>
      parseExactNumeric(quantity.raw)
    ) ||
    [...raw.matchAll(/[([]\s*([^()[\]]+)\s*[)\]]\s*[△▲−-]?\d/g)].some((match) =>
      isUncaptionedUnit(compactReportingText(match[1]))
    )
  );
}

const reportingSchedule = new RegExp(
  `^(?:${calendarDatePattern})?(?:(?:${scheduleLabels.join('|')}):?(?:${calendarDatePattern}|[-―]|未定))+$`
);
const reportingStatus = new RegExp(`^${statusLabel}:?(?:有|無)(?:\\([^()]*\\))?$`);
const reportingDate = new RegExp(`^${calendarDatePattern}$`);

/** Every character belongs to an independently supported administrative record. */
export function isReportingAdministrativeRecord(text: string): boolean {
  if (fieldName.test(fieldLabelText(text))) return false;
  const compact = compactReportingText(text);
  return (
    (isAdministrativeBlock(text) ||
      isReportingAdministrativeField(text) ||
      reportingDate.test(compact) ||
      /^\(?百万円未満切捨て\)?$/.test(compact) ||
      // PDF grouping may split this label from the date and 開催予定日.
      /^(?:定時株主総会(?:\(継続会\))?|開催予定日)$/.test(compact) ||
      reportingSchedule.test(compact) ||
      reportingStatus.test(compact)) &&
    !reportingValueText(text)
  );
}
/** Only typed field schemas may bind an otherwise independent next record. */
function ownsIndependentRecord(label: string, value: string): boolean {
  const combined = compactReportingText(label + value);
  return (
    reportingSchedule.test(combined) ||
    reportingStatus.test(combined) ||
    (/^URL:?$/i.test(fieldLabelText(label)) && /^https?:\/\/\S+$/i.test(value))
  );
}
function isIndependentReportingRecord(text: string): boolean {
  return isReportingCoverTitle(text) || isReportingAdministrativeRecord(text);
}

// A personnel record has a role and a name, or an explicitly labelled name.
// Each value occupies one cell; only explicit subfield labels may add cells.
// Without a role label, the first slot must itself identify a position.
const personnelValue = /^[\p{L}\p{M}・.'’&-]{1,80}$/u;
const personnelSubfield = (labels: string[]) => {
  const names = spacedLabels(labels);
  return new RegExp(`^(?:\\((?:${names})\\)|(?:${names})(?=\\s|:|$))\\s*:?\\s*(.*)$`, 'i');
};
const personnelSlots = {
  role: {
    label: personnelSubfield(['役職名', '役職']),
    value:
      /^(?:[\p{L}\p{M}・&-]{0,60})(?:社長|会長|取締役|執行役員?|監査役|部長|室長|課長|局長|次長|係長|責任者|CEO|COO|CFO|CTO)$/iu,
  },
  name: { label: personnelSubfield(['氏名', '担当']), value: personnelValue },
};
const inlinePersonnelSlot = new RegExp(
  `(?=\\((?:${spacedLabels(['役職名', '役職', '氏名', '担当'])})\\)|(?:^|\\s)(?:${spacedLabels(['役職名', '役職', '氏名', '担当'])})(?=\\s|:|$))`,
  'i'
);

function isPersonnelRecord(values: string[]): boolean {
  const consume = (start: number, slot: keyof typeof personnelSlots, implicit: boolean) => {
    if (!values[start]) return null;
    const schema = personnelSlots[slot];
    const field = values[start].match(schema.label);
    const end = start + (field && !field[1] ? 2 : 1);
    const value = field ? field[1] || values[start + 1] : values[start];
    if (!value || (!field && !implicit)) return null;
    // A subfield label is never a bare role/name value, even while incomplete.
    if (Object.values(personnelSlots).some((part) => part.label.test(value))) return null;
    const compact = value.replace(/\s/g, '');
    return (field ? personnelValue : schema.value).test(compact) ? end : null;
  };
  const roleEnd = consume(0, 'role', true);
  return (
    consume(0, 'name', false) === values.length ||
    (roleEnd !== null && consume(roleEnd, 'name', true) === values.length)
  );
}
function isPersonnelFieldValue(value: string, contact: boolean): boolean {
  if (!value) return false;
  const slots = value
    .split(inlinePersonnelSlot)
    .map((part) => part.trim())
    .filter(Boolean);
  if (isPersonnelRecord(slots)) return true;
  // An omitted optional role inside a single value may accompany an explicit
  // complete name. This never bridges an empty physical cell.
  if (
    slots.length === 2 &&
    slots[0].match(personnelSlots.role.label)?.[1] === '' &&
    isPersonnelRecord(slots.slice(1))
  )
    return true;
  // A role or contact department is also a complete single value. A bare
  // arbitrary string is not a role, and an extra name must fit the name slot.
  const compact = value.replace(/\s/g, '');
  if (personnelSlots.role.value.test(compact)) return true;
  if (contact && /^[\p{L}\p{M}・&-]{1,60}(?:部|室|課|局)$/u.test(compact)) return true;
  return [...value.matchAll(/\s+/g)].some((space) =>
    isPersonnelRecord([value.slice(0, space.index), value.slice(space.index! + space[0].length)])
  );
}
const personnelStart = new RegExp(
  `^(?:${spacedLabels(personnelFieldLabels)})(?=\\s|:|$)[\\s:]*(.*)$`,
  'i'
);

/** Return only the cells consumed by a complete, contiguous personnel record. */
function personnelRecordEnd(cells: string[], start: number): number | null {
  const field = cells[start].match(personnelStart);
  if (!field) return null;
  const values = field[1] ? [field[1]] : [];
  // Field label + role label/value + name label/value is the longest record.
  for (let end = start + 1; end < Math.min(cells.length, start + 5); end++) {
    if (
      !cells[end] ||
      fieldStart.test(fieldLabelText(cells[end])) ||
      isIndependentReportingRecord(cells[end])
    )
      break;
    values.push(cells[end]);
    if (isPersonnelRecord(values)) return end;
  }
  return null;
}

/** Metadata projection only: a named field can own its immediately adjacent value cell.
 * Never join rows, arbitrary cells, or the source text used for numeric validation.
 */
export function reportingFieldProjection(text: string): { segments: string[]; complete: boolean } {
  let complete = true;
  const segments = text
    .normalize('NFKC')
    .split('\n')
    .flatMap((line) => {
      const cells = line.split(/[|│]/).map((cell) => cell.trim());
      const parts: string[] = [];
      let blockedValue = false;
      for (let i = 0; i < cells.length; i++) {
        if (!cells[i]) continue;
        const independent = isIndependentReportingRecord(cells[i]);
        if (fieldStart.test(fieldLabelText(cells[i])) || independent) blockedValue = false;
        if (blockedValue) {
          complete = false;
          continue;
        }
        const recordEnd = personnelRecordEnd(cells, i);
        if (recordEnd !== null) {
          parts.push(cells.slice(i, recordEnd + 1).join(' '));
          i = recordEnd;
          continue;
        }
        if (independent) {
          parts.push(cells[i]);
          continue;
        }
        const next = cells[i + 1];
        if (
          fieldName.test(fieldLabelText(cells[i])) &&
          next &&
          !fieldStart.test(fieldLabelText(next)) &&
          (!administrativeField.test(cells[i]) ||
            isReportingAdministrativeField(`${cells[i]} ${next}`)) &&
          (!isIndependentReportingRecord(next) || ownsIndependentRecord(cells[i], next))
        )
          parts.push(`${cells[i]} ${cells[++i]}`);
        else {
          // Bare table-column atoms are not independent metadata declarations.
          if (fieldStart.test(fieldLabelText(cells[i])) || !/[|│]/.test(line)) parts.push(cells[i]);
          else complete = false;
          // A blank or unproved cell relationship cannot lend a later bare value.
          if (fieldName.test(fieldLabelText(cells[i])) && next === '') {
            blockedValue = true;
            complete = false;
          }
        }
      }
      return parts;
    });
  // Inspect final records too: pairing a company label with its next cell must
  // not conceal a malformed administrative suffix inside that consumed value.
  return { segments, complete: complete && !segments.some(hasInvalidAdministrativeField) };
}

/** Preserve projection consumers; completeness is required only for whole-block metadata. */
export function reportingFieldSegments(text: string): string[] {
  return reportingFieldProjection(text).segments;
}

/** An unavailable reporting attribute is unresolved, never a wildcard. */
export function hasCompleteReportingAttributes(
  attributes: { subject: string | null; scope: string | null; basis: string | null } | null
): attributes is { subject: string; scope: string; basis: string } {
  return (
    attributes !== null &&
    (['subject', 'scope', 'basis'] as const).every(
      (role) => typeof attributes[role] === 'string' && attributes[role]!.trim().length > 0
    )
  );
}

/** Only complete administrative blocks are excluded, never a substantive continuation. */
export function isAdministrativeBlock(text: string): boolean {
  const lines = text
    .normalize('NFKC')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        !/[。;；|│]/.test(line) &&
        ((/^(?:上場会社名|会社名)(?:\s|:)/.test(line) && !hasInvalidAdministrativeField(line)) ||
          isReportingAdministrativeField(line) ||
          isReportingUrl(line) ||
          /^(?:各位|以上)$/.test(line))
    )
  );
}
