import { normalizeTdnetPdfUrl } from './tdnet-url';

export const NATIVE_DISCLOSURE_VERSION = 1 as const;
export const NATIVE_LIMITS = {
  archiveBytes: 8 * 1024 * 1024,
  entryBytes: 4 * 1024 * 1024,
  totalBytes: 24 * 1024 * 1024,
  entries: 160,
  facts: 20000,
  nodes: 200000,
  tableCells: 50000,
} as const;

/** Only a link actually present in the user's selected official row. Never synthesize ZIP URLs. */
export interface NativeCompanionRef {
  kind: 'tdnet-row';
  zipUrl: string;
  pdfUrl: string;
  disclosureId: string;
  listingUrl: string;
  publishedDate: string;
  code: string;
  title: string;
  correction: boolean;
}
export interface NativeQName {
  qname: string;
  namespace: string;
  localName: string;
}
export interface NativeContext {
  id: string;
  documentSetId: string;
  sourceFiles: string[];
  entity: { identifier: string; scheme: string };
  period: { start: string | null; end: string | null; instant: string | null };
  dimensions: Array<{ axis: string; member: string | null; typedValue: string | null }>;
  /** Other segment/scenario qualifiers are retained and are not safe automatic comparison axes. */
  otherContent: string[];
  /** Hints only from explicit TDnet dimensions; absent defaults are not guessed. */
  valueKind: 'actual' | 'forecast' | null;
  consolidation: 'consolidated' | 'nonconsolidated' | null;
}
export interface NativeUnit {
  id: string;
  documentSetId: string;
  numerator: string[];
  denominator: string[];
}
export interface NativeFact {
  id: string;
  documentSetId: string;
  file: string;
  concept: NativeQName;
  contextId: string;
  unitId: string | null;
  kind: 'number' | 'text';
  literal: string;
  /** Exact decimal for numbers, canonical text for supported text transforms; original literal always retained. */
  value: string | null;
  status: 'parsed' | 'nil' | 'unsupported';
  scale: number;
  sign: '-' | null;
  decimals: string | null;
  format: string | null;
  rowText: string | null;
  tableId: string | null;
  cellId: string | null;
}
export interface NativeHtmlCell {
  id: string;
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  tag: 'th' | 'td';
  text: string;
  /** Original HTML headers/scope are retained, without inventing financial semantics. */
  headers: string[];
  scope: string | null;
}
export interface NativeHtmlTable {
  id: string;
  file: string;
  caption: string | null;
  cells: NativeHtmlCell[];
  rows: Array<{ id: string; index: number; cellIds: string[]; text: string }>;
}
export interface NativeHtmlPassage {
  id: string;
  file: string;
  kind: 'heading' | 'paragraph' | 'note';
  text: string;
}
export interface NativeDisclosure {
  version: typeof NATIVE_DISCLOSURE_VERSION;
  hash: string;
  source: NativeCompanionRef;
  status: 'eligible' | 'ineligible';
  reasons: string[];
  /** Pairing/issuer/date checks only. Numerical and narrative meaning still need review. */
  consistency: { pdfIdentity: 'matched' | 'unverified' | 'mismatch'; numeric: 'not-compared' };
  documents: Array<{ file: string; documentSetId: string; kind: 'ixbrl' | 'html' }>;
  contexts: NativeContext[];
  units: NativeUnit[];
  facts: NativeFact[];
  tables: NativeHtmlTable[];
  passages: NativeHtmlPassage[];
  warnings: string[];
  /** Detect accidental or persisted tampering before use; not a cryptographic trust assertion. */
  checksum: string;
}
export function normalizeSecurityCode(code: string): string | null {
  const value = code.normalize('NFKC').trim().toUpperCase();
  // TDnet appends a single zero to its four-character listed security code.
  return /^[0-9A-Z]{4}0$/.test(value)
    ? value.slice(0, 4)
    : /^[0-9A-Z]{4}$/.test(value)
      ? value
      : null;
}
export function validateNativeCompanionRef(value: unknown, pdfUrl?: string): NativeCompanionRef {
  if (!value || typeof value !== 'object')
    throw new Error('NATIVE:同じ開示行のXBRLリンクがありません');
  const r = value as NativeCompanionRef;
  if (
    r.kind !== 'tdnet-row' ||
    typeof r.zipUrl !== 'string' ||
    typeof r.pdfUrl !== 'string' ||
    typeof r.listingUrl !== 'string' ||
    typeof r.code !== 'string' ||
    typeof r.title !== 'string' ||
    typeof r.publishedDate !== 'string' ||
    typeof r.disclosureId !== 'string' ||
    typeof r.correction !== 'boolean'
  )
    throw new Error('NATIVE:開示行の参照形式が不正です');
  const pdf = normalizeTdnetPdfUrl(r.pdfUrl);
  const zip = new URL(r.zipUrl);
  const listing = new URL(r.listingUrl);
  const pdfId = new URL(pdf).pathname.match(/^\/inbs\/1401(\d{14})\.pdf$/)?.[1];
  const zipId = zip.pathname.match(/^\/inbs\/0812(\d{14})\.zip$/)?.[1];
  const listDate = listing.pathname.match(/^\/inbs\/I_list_\d{3}_(\d{4})(\d{2})(\d{2})\.html$/);
  if (
    zip.origin !== 'https://www.release.tdnet.info' ||
    listing.origin !== zip.origin ||
    zip.username ||
    zip.password ||
    zip.search ||
    zip.hash ||
    listing.username ||
    listing.password ||
    listing.search ||
    listing.hash ||
    new URL(pdf).search ||
    new URL(pdf).hash ||
    !pdfId ||
    pdfId !== zipId ||
    pdfId !== r.disclosureId ||
    !listDate ||
    r.publishedDate !== `${listDate[1]}-${listDate[2]}-${listDate[3]}` ||
    !normalizeSecurityCode(r.code) ||
    !r.title.trim() ||
    r.title.length > 1000 ||
    (pdfUrl && pdf !== normalizeTdnetPdfUrl(pdfUrl))
  )
    throw new Error('NATIVE:PDFとXBRLの開示行・識別子が一致しません');
  if (/訂正|修正|correction|corrected/i.test(r.title) && !r.correction)
    throw new Error('NATIVE:訂正開示を通常開示として扱えません');
  return { ...r, pdfUrl: pdf, zipUrl: zip.href, listingUrl: listing.href };
}
