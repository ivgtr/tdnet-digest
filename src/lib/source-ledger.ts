import type { ExtractedPage } from '@/types/summaryMetadata';
import { canonicalJSON, exact, hashText, record } from './fact-contract';
import { sourceInventory } from './summary-source-inventory';
import type { ContentRole } from './summary-content-policy';
import type { DocumentType } from './document-type';

/** Source layout, not a verified financial assertion. Coordinates retain extraction precision. */
type Box = [number, number, number, number];
export interface SourceLedgerSpan {
  id: string;
  text: string;
  box: Box;
  sourceIds: string[];
}
export interface SourceLedgerRow {
  id: string;
  page: number;
  kind: 'paragraph' | 'row';
  text: string;
  spanIds: string[];
  marks: { role: ContentRole | null; headingId: string | null };
}
export interface SourceLedgerPage {
  pageNumber: number;
  text: string;
  status: ExtractedPage['status'];
  selection: ExtractedPage['selection'];
  spans: SourceLedgerSpan[];
  sourceItems: Array<{ id: string; text: string; box: Box }>;
  quantities: Array<{ id: string; text: string; spanIds: string[]; box: Box; unit: null }>;
  tables: Array<{
    id: string;
    method: 'ruled' | 'aligned';
    spanIds: string[];
    valueIds: string[];
    unitIds: string[];
    cells: Array<{ id: string; box: Box; spanIds: string[] }>;
    top: number;
    bottom: number;
  }>;
}
export interface SourceLedger {
  version: 1;
  sourceHash: string;
  pages: SourceLedgerPage[];
  rows: SourceLedgerRow[];
}
const roles: ContentRole[] = [
  'content',
  'performance',
  'outlook',
  'dividend',
  'finance',
  'operations',
  'reason',
  'purpose',
  'target',
  'impact',
  'timing',
  'conditions',
  'notes',
  'document',
  'unclassified',
];
const boxOf = (v: { x: number; y: number; width: number; height: number }): Box => [
  v.x,
  v.y,
  v.width,
  v.height,
];
const checksum = (v: Omit<SourceLedger, 'sourceHash'>) => hashText(canonicalJSON(v));
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Every source block survives. Recognition adds hints only; it never gates retention. */
export function buildSourceLedger(
  pages: ExtractedPage[],
  documentType: DocumentType = 'other'
): SourceLedger {
  const hints = new Map(sourceInventory(pages, undefined, documentType).map((e) => [e.blockId, e]));
  const body: Omit<SourceLedger, 'sourceHash'> = {
    version: 1,
    pages: pages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.text,
      status: p.status,
      selection: p.selection,
      spans: p.spans.map((s) => ({
        id: s.id,
        text: s.text,
        box: boxOf(s),
        sourceIds: [...(s.sourceIds ?? [])],
      })),
      sourceItems: p.sourceItems.map((s) => ({ id: s.id, text: s.text, box: boxOf(s) })),
      // A literal cell is preserved even when its unit or financial meaning is unresolved.
      quantities: p.quantities.map((q) => ({
        id: q.id,
        text: q.text,
        spanIds: [...q.spanIds],
        box: boxOf(q),
        unit: null,
      })),
      tables: p.tableRegions.map((t) => ({
        id: t.id,
        method: t.method,
        spanIds: [...t.spanIds],
        valueIds: [...t.valueIds],
        unitIds: [...t.unitIds],
        top: t.top,
        bottom: t.bottom,
        cells: t.cells.map((c) => ({
          id: c.id,
          box: [c.left, c.top, c.right, c.bottom],
          spanIds: [...c.spanIds],
        })),
      })),
    })),
    rows: pages.flatMap((p) =>
      p.blocks.map((b) => ({
        id: b.id,
        page: p.pageNumber,
        kind: b.kind,
        text: b.text,
        spanIds: [...b.spanIds],
        marks: {
          role: hints.get(b.id)?.role ?? null,
          headingId: hints.get(b.id)?.heading?.id ?? null,
        },
      }))
    ),
  };
  return validateSourceLedger({ ...body, sourceHash: checksum(body) });
}

const fail = (): never => {
  throw new Error('SOURCE_LEDGER: 原文台帳の構造・参照・ハッシュが不正です');
};
const object = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!record(v) || !exact(v, keys)) return fail();
  return v;
};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : fail());
const id = (v: unknown): string => (typeof v === 'string' && v.length > 0 ? v : fail());
const text = (v: unknown): string => (typeof v === 'string' ? v : fail());
const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : fail());
const box = (v: unknown) => {
  if (list(v).length !== 4) fail();
  list(v).forEach(finite);
};
const ids = (v: unknown): string[] => {
  const values = list(v).map(id);
  if (new Set(values).size !== values.length) fail();
  return values;
};
function add(set: Set<string>, value: unknown) {
  const key = id(value);
  if (set.has(key)) fail();
  set.add(key);
}
function refs(v: unknown, allowed: Set<string>) {
  if (ids(v).some((key) => !allowed.has(key))) fail();
}

/** Integrity is source integrity only, never proof of units, periods, or financial semantics. */
export function validateSourceLedger(value: unknown): SourceLedger {
  const root = object(value, ['version', 'sourceHash', 'pages', 'rows']);
  if (root.version !== 1 || !/^[a-f0-9]{16}$/.test(text(root.sourceHash))) fail();
  const pageNumbers = new Set<number>();
  const allSpans = new Set<string>(),
    allItems = new Set<string>();
  const allQuantities = new Set<string>(),
    allTables = new Set<string>(),
    allCells = new Set<string>();
  const pageSpans = new Map<number, Set<string>>();
  for (const raw of list(root.pages)) {
    const p = object(raw, [
      'pageNumber',
      'text',
      'status',
      'selection',
      'spans',
      'sourceItems',
      'quantities',
      'tables',
    ]);
    const n = finite(p.pageNumber);
    if (!Number.isInteger(n) || n < 1 || pageNumbers.has(n)) fail();
    pageNumbers.add(n);
    text(p.text);
    if (
      !['ok', 'empty', 'failed'].includes(text(p.status)) ||
      !['selected', 'omitted'].includes(text(p.selection))
    )
      fail();
    const items = new Set<string>(),
      spans = new Set<string>(),
      quantities = new Set<string>();
    for (const rawItem of list(p.sourceItems)) {
      const s = object(rawItem, ['id', 'text', 'box']);
      add(allItems, s.id);
      add(items, s.id);
      text(s.text);
      box(s.box);
    }
    for (const rawSpan of list(p.spans)) {
      const s = object(rawSpan, ['id', 'text', 'box', 'sourceIds']);
      add(allSpans, s.id);
      add(spans, s.id);
      text(s.text);
      box(s.box);
      refs(s.sourceIds, items);
    }
    pageSpans.set(n, spans);
    for (const rawQuantity of list(p.quantities)) {
      const q = object(rawQuantity, ['id', 'text', 'spanIds', 'box', 'unit']);
      add(allQuantities, q.id);
      add(quantities, q.id);
      text(q.text);
      box(q.box);
      refs(q.spanIds, spans);
      if (q.unit !== null || list(q.spanIds).length === 0) fail();
    }
    for (const rawTable of list(p.tables)) {
      const t = object(rawTable, [
        'id',
        'method',
        'spanIds',
        'valueIds',
        'unitIds',
        'cells',
        'top',
        'bottom',
      ]);
      add(allTables, t.id);
      if (!['ruled', 'aligned'].includes(text(t.method)) || finite(t.top) > finite(t.bottom))
        fail();
      refs(t.spanIds, spans);
      const members = new Set(ids(t.spanIds));
      refs(t.unitIds, members);
      refs(t.valueIds, quantities);
      for (const rawCell of list(t.cells)) {
        const c = object(rawCell, ['id', 'box', 'spanIds']);
        add(allCells, c.id);
        box(c.box);
        refs(c.spanIds, members);
        const bounds = c.box as Box;
        if (bounds[0] > bounds[2] || bounds[1] > bounds[3]) fail();
      }
    }
  }
  const rows = new Set<string>();
  for (const raw of list(root.rows)) {
    const r = object(raw, ['id', 'page', 'kind', 'text', 'spanIds', 'marks']);
    add(rows, r.id);
    text(r.text);
    const spans = pageSpans.get(finite(r.page));
    if (!spans || !['paragraph', 'row'].includes(text(r.kind))) fail();
    refs(r.spanIds, spans!);
    const marks = object(r.marks, ['role', 'headingId']);
    if (marks.role !== null && !roles.includes(text(marks.role) as ContentRole)) fail();
    if (marks.headingId !== null) id(marks.headingId);
  }
  for (const raw of list(root.rows)) {
    const r = raw as SourceLedgerRow;
    if (r.marks.headingId !== null && !rows.has(r.marks.headingId)) fail();
  }
  // Quantities may intentionally reuse their owning span ID. Other entity IDs are distinct.
  const identities = new Set<string>();
  for (const category of [allItems, allSpans, allTables, allCells, rows]) {
    for (const key of category) add(identities, key);
  }
  for (const key of allQuantities) {
    if (identities.has(key) && !allSpans.has(key)) fail();
  }
  const body = {
    version: 1 as const,
    pages: root.pages as SourceLedgerPage[],
    rows: root.rows as SourceLedgerRow[],
  };
  if (checksum(body) !== root.sourceHash) fail();
  // Detach from caller/storage objects, so neither projection nor validation mutates inputs.
  return freeze(JSON.parse(JSON.stringify(value)) as SourceLedger);
}

/** Original text absent from the reading spans remains independently citable.
 * Coverage is scoped to provenance IDs, never equal text elsewhere on the page.
 * A claimed source ID alone is insufficient: filtered/partial spans can lose text.
 * Trimming matches native span construction; returned originals retain their exact text.
 */
export function unrepresentedSourceItems(page: SourceLedgerPage): SourceLedgerPage['sourceItems'] {
  const items = new Map(page.sourceItems.map((item) => [item.id, item]));
  const covered = new Set<string>();
  const fragments = new Map<string, string[]>();
  for (const span of page.spans) {
    if (span.sourceIds.length === 1) {
      const sourceId = span.sourceIds[0];
      if (!fragments.has(sourceId)) fragments.set(sourceId, []);
      fragments.get(sourceId)!.push(span.text);
      continue;
    }
    // Merged native items appear in sourceIds order. Consume separate text ranges,
    // so one surviving occurrence cannot cover two equal-text originals.
    let cursor = 0;
    for (const sourceId of span.sourceIds) {
      const original = items.get(sourceId)?.text.trim();
      if (!original) continue;
      const at = span.text.indexOf(original, cursor);
      if (at < 0) continue;
      covered.add(sourceId);
      cursor = at + original.length;
    }
  }
  for (const [sourceId, parts] of fragments) {
    const original = items.get(sourceId)?.text.trim();
    if (original && parts.join('').includes(original)) covered.add(sourceId);
  }
  return page.sourceItems.filter((item) => item.text.trim() && !covered.has(item.id));
}

/** Compact reading view. Rounded positions are hints, not numeric verification inputs. */
export interface SourceModelInput {
  sourceHash: string;
  columns: {
    rows: ['blockId', 'text', 'cells'];
    cells: ['spanId', 'text', 'x', 'y'];
    originalItems: ['sourceItemId', 'text', 'x', 'y'];
    marks: ['roleHint', 'headingId', 'blockIds'];
    tables: ['tableId', 'method', 'unitSpanIds', 'cells', 'spanIds'];
    tableCells: ['cellId', 'spanIds'];
  };
  coverage: { pages: number; rows: number; spans: number; quantities: number; tables: number };
  pages: Array<{
    pageNumber: number;
    status: SourceLedgerPage['status'];
    selection: SourceLedgerPage['selection'];
    rows: Array<[string, string, Array<[string, string, number, number]>]>;
    marks: Array<[ContentRole | null, string | null, string[]]>;
    looseSpans: Array<[string, string, number, number]>;
    originalItems: Array<[string, string, number, number]>;
    tables: Array<[string, 'ruled' | 'aligned', string[], Array<[string, string[]]>, string[]]>;
  }>;
}
export function sourceLedgerModelInput(ledger: SourceLedger): SourceModelInput {
  const position = (
    s: Pick<SourceLedgerSpan, 'id' | 'text' | 'box'>
  ): [string, string, number, number] => [
    s.id,
    s.text,
    Math.round(s.box[0] * 10) / 10,
    Math.round(s.box[1] * 10) / 10,
  ];
  return {
    sourceHash: ledger.sourceHash,
    columns: {
      rows: ['blockId', 'text', 'cells'],
      cells: ['spanId', 'text', 'x', 'y'],
      originalItems: ['sourceItemId', 'text', 'x', 'y'],
      marks: ['roleHint', 'headingId', 'blockIds'],
      tables: ['tableId', 'method', 'unitSpanIds', 'cells', 'spanIds'],
      tableCells: ['cellId', 'spanIds'],
    },
    coverage: {
      pages: ledger.pages.length,
      rows: ledger.rows.length,
      spans: ledger.pages.reduce((n, p) => n + p.spans.length, 0),
      quantities: ledger.pages.reduce((n, p) => n + p.quantities.length, 0),
      tables: ledger.pages.reduce((n, p) => n + p.tables.length, 0),
    },
    pages: ledger.pages.map((p) => {
      const spans = new Map(p.spans.map((s) => [s.id, s]));
      const rows = ledger.rows.filter((r) => r.page === p.pageNumber);
      const used = new Set(rows.flatMap((r) => r.spanIds));
      // Group identical hints, retaining explicit row memberships rather than inferred ranges.
      const marks = new Map<string, SourceModelInput['pages'][number]['marks'][number]>();
      for (const row of rows) {
        if (row.marks.role === null && row.marks.headingId === null) continue;
        const key = canonicalJSON(row.marks);
        if (!marks.has(key)) marks.set(key, [row.marks.role, row.marks.headingId, []]);
        marks.get(key)![2].push(row.id);
      }
      return {
        pageNumber: p.pageNumber,
        status: p.status,
        selection: p.selection,
        rows: rows.map((r) => [r.id, r.text, r.spanIds.map((id) => position(spans.get(id)!))]),
        marks: [...marks.values()],
        looseSpans: p.spans.filter((s) => !used.has(s.id)).map(position),
        originalItems: unrepresentedSourceItems(p).map(position),
        tables: p.tables.map((t) => [
          t.id,
          t.method,
          [...t.unitIds],
          t.cells.map((c) => [c.id, [...c.spanIds]]),
          [...t.spanIds],
        ]),
      };
    }),
  };
}

/** Allowlisted trace copy: no arbitrary properties from transport objects enter the trace. */
export function projectSourceModelInput(input: SourceModelInput): SourceModelInput {
  const cell = (c: [string, string, number, number]): [string, string, number, number] => [
    c[0],
    c[1],
    c[2],
    c[3],
  ];
  return {
    sourceHash: input.sourceHash,
    columns: {
      rows: ['blockId', 'text', 'cells'],
      cells: ['spanId', 'text', 'x', 'y'],
      originalItems: ['sourceItemId', 'text', 'x', 'y'],
      marks: ['roleHint', 'headingId', 'blockIds'],
      tables: ['tableId', 'method', 'unitSpanIds', 'cells', 'spanIds'],
      tableCells: ['cellId', 'spanIds'],
    },
    coverage: {
      pages: input.coverage.pages,
      rows: input.coverage.rows,
      spans: input.coverage.spans,
      quantities: input.coverage.quantities,
      tables: input.coverage.tables,
    },
    pages: input.pages.map((p) => ({
      pageNumber: p.pageNumber,
      status: p.status,
      selection: p.selection,
      rows: p.rows.map((r) => [r[0], r[1], r[2].map(cell)]),
      marks: p.marks.map((m) => [m[0], m[1], m[2].map((id) => id)]),
      looseSpans: p.looseSpans.map(cell),
      originalItems: p.originalItems.map(cell),
      tables: p.tables.map((t) => [
        t[0],
        t[1],
        t[2].map((id) => id),
        t[3].map((c) => [c[0], c[1].map((id) => id)]),
        t[4].map((id) => id),
      ]),
    })),
  };
}
