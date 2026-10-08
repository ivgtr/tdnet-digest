/** Source vocabulary shared by reporting declarations and their consumers. */
export const reportingScope = '非連結|個別|単体|連結';
export const reportingBasis = '日本基準|IFRS(?:会計基準)?|国際会計基準|米国基準';

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
const fieldLabels = `上場会社名|会社名|名称|範囲|会計基準|株式種類|取得対象株式(?:の)?種類|${administrativeFieldLabels.join('|')}`;
const fieldName = new RegExp(`^(?:${fieldLabels}):?$`, 'i');
const fieldStart = new RegExp(`^(?:${fieldLabels})`, 'i');
const fieldLabelText = (part: string) =>
  part.replace(/\s/g, '').replace(/^(?:\(\d+\)|\d+[.．])/, '');
const spacedLabels = (labels: string[]) => labels.map((label) => [...label].join('\\s*')).join('|');

/** Spacing between label glyphs is layout, but a field still needs a value delimiter. */
const administrativeField = new RegExp(
  `^(?:${spacedLabels(administrativeFieldLabels)})(?:\\s+|:)\\s*\\S`,
  'i'
);
export function isReportingAdministrativeField(text: string): boolean {
  return administrativeField.test(text.normalize('NFKC').trim());
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
    if (!cells[end] || fieldStart.test(fieldLabelText(cells[end]))) break;
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
        if (fieldStart.test(fieldLabelText(cells[i]))) blockedValue = false;
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
        const next = cells[i + 1];
        if (
          fieldName.test(fieldLabelText(cells[i])) &&
          next &&
          !fieldStart.test(fieldLabelText(next))
        )
          parts.push(`${cells[i]} ${cells[++i]}`);
        else {
          // Bare table-column atoms are not independent metadata declarations.
          if (fieldStart.test(fieldLabelText(cells[i])) || !/[|│]/.test(line)) parts.push(cells[i]);
          else complete = false;
          // A blank or unproved cell relationship cannot lend a later bare value.
          if (fieldName.test(fieldLabelText(cells[i])) && next === '') blockedValue = true;
        }
      }
      return parts;
    });
  return { segments, complete };
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
        (/^(?:上場会社名|会社名|コード番号|証券コード|代表者名?|問合せ先|問い合わせ先|電話番号|TEL|URL)(?:\s|[:：])/i.test(
          line
        ) ||
          /^(?:https?:\/\/\S+|各位|以上)$/i.test(line))
    )
  );
}
