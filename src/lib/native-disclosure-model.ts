import type { NativeDisclosure } from './native-disclosure-contract';

/** Lossless source content with shared dictionaries. Public cite IDs are 1-based:
 * fN facts, pN passages, tNrM table rows. Original IDs remain in saved NativeDisclosure. */
export interface NativeModelInput {
  sourceKind: 'tdnet-native';
  evidenceStatus: 'company-source-unreviewed';
  encoding: 'native-columnar-v1';
  version: number;
  hash: string;
  source: NativeDisclosure['source'];
  status: NativeDisclosure['status'];
  reasons: string[];
  consistency: NativeDisclosure['consistency'];
  schema: Record<string, string[]>;
  referenceRules: string[];
  namespaces: string[];
  texts: string[];
  files: string[];
  documentSets: string[];
  qnames: Array<[number, string]>;
  concepts: Array<[string, number, string]>;
  entities: Array<[string, string]>;
  documents: Array<[number, number, 'ixbrl' | 'html']>;
  contexts: Array<
    [
      number,
      string,
      number[],
      number,
      string | null,
      string | null,
      string | null,
      Array<[number, number | null, number | null]>,
      'actual' | 'forecast' | null,
      'consolidated' | 'nonconsolidated' | null,
      number[],
    ]
  >;
  units: Array<[number, string, number[], number[]]>;
  factAttributes: Array<
    [
      number | null,
      'number' | 'text',
      'parsed' | 'nil' | 'unsupported',
      number,
      '-' | null,
      string | null,
      number | null,
    ]
  >;
  facts: Array<
    [number, number, number, number, number, string | number | null, number | null, number | null]
  >;
  tables: Array<
    [
      number,
      string,
      number | null,
      Array<[number, number, number, [number, number, 'td' | 'th', string[], string | null]?]>,
      Array<[number, number, number]>,
    ]
  >;
  passages: Array<[number, string, 'heading' | 'paragraph' | 'note', number]>;
  warnings: string[];
}
const SCHEMA: NativeModelInput['schema'] = {
  qnames: ['namespace index', 'local name'],
  concepts: ['original QName prefix (empty for unprefixed)', 'namespace index', 'local name'],
  entities: ['identifier', 'identifier scheme'],
  documents: ['file index', 'documentSet index', 'kind'],
  contexts: [
    'documentSet index',
    'original ID suffix',
    'definition file indices',
    'entity index',
    'start date',
    'end date',
    'instant date',
    'dimensions [axis QName index, member QName index|null, typed XML text index|null]',
    'actual/forecast hint|null',
    'consolidation hint|null',
    'other segment/scenario XML text indices (not comparable automatically)',
  ],
  units: [
    'documentSet index',
    'original ID suffix',
    'numerator QName indices',
    'denominator QName indices',
  ],
  factAttributes: [
    'unit index|null',
    'kind',
    'status',
    'scale',
    'sign',
    'decimals',
    'format QName index|null',
  ],
  facts: [
    'file index',
    'concept index',
    'context index',
    'factAttributes index',
    'literal text index',
    'exact decimal value OR text index|null',
    'table index|null',
    'table cell index|null',
  ],
  tables: ['file index', 'original ID suffix', 'caption text index|null', 'cells', 'rows'],
  cells: [
    'row index',
    'column index',
    'text index',
    'optional [rowspan,colspan,tag,original headers,scope]; omitted defaults [1,1,td,[],null]',
  ],
  rows: ['row index', 'first cell index', 'cell count (consecutive indices)'],
  passages: ['file index', 'original ID suffix', 'kind', 'text index'],
};
const RULES = [
  'All dictionary and array references are zero-based. Citation aliases are one-based: facts f1.., passages p1.., table rows t1r1.. in the stored array order.',
  'Use native:fN, native:pN or native:tNrM to cite. A fact value is an exact decimal string for number kind, a texts index for text kind, or null for nil/unsupported. Null is never zero.',
  'Original fact IDs are files[file index]+"#fact-"+one-based fact ordinal within that file; table/passage IDs are files[file index]+"#"+original ID suffix. Original context/unit IDs are documentSets[documentSet index]+"#"+original ID suffix. Original cell IDs are table original ID+":r"+(row index+1)+"c"+(column index+1); original row IDs are table original ID+":r"+(row index+1).',
  'Table row text equals its cell texts joined with " | ". A fact rowText is that row text when a cell is referenced, otherwise null. No original row or cell content is removed.',
  'Original concept QName is prefix+":"+localName, or localName when prefix is empty. Expanded identity is the namespace URI plus localName. Original QName prefixes never determine concept identity.',
  'Full company text and all concepts are preserved. HTML cell geometry, units, notes and unclassified rows do not establish verified financial meaning. PDF numerical consistency is not established by identity matching.',
];
function add<T>(array: T[], key: string, keys: Map<string, number>, value: T): number {
  const old = keys.get(key);
  if (old !== undefined) return old;
  const index = array.length;
  array.push(value);
  keys.set(key, index);
  return index;
}
export function compactNativeDisclosure(n: Omit<NativeDisclosure, 'checksum'>): NativeModelInput {
  const namespaces: string[] = [],
    namespaceKeys = new Map<string, number>();
  const texts: string[] = [],
    textKeys = new Map<string, number>();
  const qnames: NativeModelInput['qnames'] = [],
    qnameKeys = new Map<string, number>();
  const concepts: NativeModelInput['concepts'] = [],
    conceptKeys = new Map<string, number>();
  const entities: NativeModelInput['entities'] = [],
    entityKeys = new Map<string, number>();
  const factAttributes: NativeModelInput['factAttributes'] = [],
    attributeKeys = new Map<string, number>();
  const ns = (s: string) => add(namespaces, s, namespaceKeys, s);
  const txt = (s: string) => add(texts, s, textKeys, s);
  const qn = (s: string) => {
    const match = s.match(/^\{([^}]+)\}([^{}]+)$/);
    if (!match) throw new Error('NATIVE:展開済み概念名が不正です');
    return add(qnames, s, qnameKeys, [ns(match[1]), match[2]]);
  };
  const files = n.documents.map((d) => d.file);
  const fileIndex = new Map(files.map((file, i) => [file, i]));
  const documentSets = [...new Set(n.documents.map((d) => d.documentSetId))];
  const setIndex = new Map(documentSets.map((set, i) => [set, i]));
  const contextsIndex = new Map(n.contexts.map((c, i) => [c.id, i]));
  const unitsIndex = new Map(n.units.map((u, i) => [u.id, i]));
  const tablesIndex = new Map(n.tables.map((t, i) => [t.id, i]));
  const cellIndex = new Map(n.tables.flatMap((t) => t.cells.map((c, i) => [c.id, i] as const)));
  const get = (map: Map<string, number>, key: string): number => {
    const i = map.get(key);
    if (i === undefined) throw new Error('NATIVE:圧縮原文の参照が不正です');
    return i;
  };
  const suffix = (id: string, prefix: string, separator: string) => {
    if (!id.startsWith(prefix + separator)) throw new Error('NATIVE:原文IDの対応を確定できません');
    return id.slice(prefix.length + separator.length);
  };
  const contexts: NativeModelInput['contexts'] = n.contexts.map((c) => [
    get(setIndex, c.documentSetId),
    suffix(c.id, c.documentSetId, '#'),
    c.sourceFiles.map((f) => get(fileIndex, f)),
    add(entities, JSON.stringify(c.entity), entityKeys, [c.entity.identifier, c.entity.scheme]),
    c.period.start,
    c.period.end,
    c.period.instant,
    c.dimensions.map((d) => [
      qn(d.axis),
      d.member === null ? null : qn(d.member),
      d.typedValue === null ? null : txt(d.typedValue),
    ]),
    c.valueKind,
    c.consolidation,
    c.otherContent.map(txt),
  ]);
  const units: NativeModelInput['units'] = n.units.map((u) => [
    get(setIndex, u.documentSetId),
    suffix(u.id, u.documentSetId, '#'),
    u.numerator.map(qn),
    u.denominator.map(qn),
  ]);
  const factOrdinals = new Map<string, number>();
  const facts: NativeModelInput['facts'] = n.facts.map((f) => {
    const ordinal = (factOrdinals.get(f.file) ?? 0) + 1;
    factOrdinals.set(f.file, ordinal);
    if (f.id !== `${f.file}#fact-${ordinal}`) throw new Error('NATIVE:事実IDの圧縮対応が不正です');
    const attributes: NativeModelInput['factAttributes'][number] = [
      f.unitId === null ? null : get(unitsIndex, f.unitId),
      f.kind,
      f.status,
      f.scale,
      f.sign,
      f.decimals,
      f.format === null ? null : qn(f.format),
    ];
    const prefix = f.concept.qname.includes(':') ? f.concept.qname.split(':')[0] : '';
    if (f.concept.qname !== (prefix ? prefix + ':' : '') + f.concept.localName)
      throw new Error('NATIVE:概念名の圧縮対応が不正です');
    return [
      get(fileIndex, f.file),
      add(concepts, JSON.stringify(f.concept), conceptKeys, [
        prefix,
        ns(f.concept.namespace),
        f.concept.localName,
      ]),
      get(contextsIndex, f.contextId),
      add(factAttributes, JSON.stringify(attributes), attributeKeys, attributes),
      txt(f.literal),
      f.value === null ? null : f.kind === 'text' ? txt(f.value) : f.value,
      f.tableId === null ? null : get(tablesIndex, f.tableId),
      f.cellId === null ? null : get(cellIndex, f.cellId),
    ];
  });
  const tables: NativeModelInput['tables'] = n.tables.map((t) => [
    get(fileIndex, t.file),
    suffix(t.id, t.file, '#'),
    t.caption === null ? null : txt(t.caption),
    t.cells.map((c) => {
      if (c.id !== `${t.id}:r${c.row + 1}c${c.column + 1}`)
        throw new Error('NATIVE:セルIDの圧縮対応が不正です');
      return c.rowSpan === 1 &&
        c.colSpan === 1 &&
        c.tag === 'td' &&
        !c.headers.length &&
        c.scope === null
        ? [c.row, c.column, txt(c.text)]
        : [c.row, c.column, txt(c.text), [c.rowSpan, c.colSpan, c.tag, [...c.headers], c.scope]];
    }),
    t.rows.map((r) => {
      const indices = r.cellIds.map((id) => get(cellIndex, id));
      if (
        r.id !== `${t.id}:r${r.index + 1}` ||
        indices.some((index, i) => index !== indices[0] + i)
      )
        throw new Error('NATIVE:行セルの連続性を確認できません');
      return [r.index, indices[0] ?? 0, indices.length];
    }),
  ]);
  const passages: NativeModelInput['passages'] = n.passages.map((p) => [
    get(fileIndex, p.file),
    suffix(p.id, p.file, '#'),
    p.kind,
    txt(p.text),
  ]);
  const { kind, zipUrl, pdfUrl, disclosureId, listingUrl, publishedDate, code, title, correction } =
    n.source;
  return {
    sourceKind: 'tdnet-native',
    evidenceStatus: 'company-source-unreviewed',
    encoding: 'native-columnar-v1',
    version: n.version,
    hash: n.hash,
    source: {
      kind,
      zipUrl,
      pdfUrl,
      disclosureId,
      listingUrl,
      publishedDate,
      code,
      title,
      correction,
    },
    status: n.status,
    reasons: [...n.reasons],
    consistency: { pdfIdentity: n.consistency.pdfIdentity, numeric: n.consistency.numeric },
    schema: Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, [...v]])),
    referenceRules: [...RULES],
    namespaces,
    texts,
    files,
    documentSets,
    qnames,
    concepts,
    entities,
    documents: n.documents.map((d) => [
      get(fileIndex, d.file),
      get(setIndex, d.documentSetId),
      d.kind,
    ]),
    contexts,
    units,
    factAttributes,
    facts,
    tables,
    passages,
    warnings: [...n.warnings],
  };
}
/** Re-project compact diagnostic input without trusting extra saved object properties. */
export function projectCompactNativeInput(n: NativeModelInput): NativeModelInput {
  const { kind, zipUrl, pdfUrl, disclosureId, listingUrl, publishedDate, code, title, correction } =
    n.source;
  return {
    sourceKind: 'tdnet-native',
    evidenceStatus: 'company-source-unreviewed',
    encoding: 'native-columnar-v1',
    version: n.version,
    hash: n.hash,
    source: {
      kind,
      zipUrl,
      pdfUrl,
      disclosureId,
      listingUrl,
      publishedDate,
      code,
      title,
      correction,
    },
    status: n.status,
    reasons: [...n.reasons],
    consistency: { pdfIdentity: n.consistency.pdfIdentity, numeric: n.consistency.numeric },
    schema: Object.fromEntries(Object.entries(SCHEMA).map(([k, v]) => [k, [...v]])),
    referenceRules: [...RULES],
    namespaces: [...n.namespaces],
    texts: [...n.texts],
    files: [...n.files],
    documentSets: [...n.documentSets],
    qnames: n.qnames.map(([a, b]) => [a, b]),
    concepts: n.concepts.map(([a, b, c]) => [a, b, c]),
    entities: n.entities.map(([a, b]) => [a, b]),
    documents: n.documents.map(([a, b, c]) => [a, b, c]),
    contexts: n.contexts.map(([a, b, c, d, e, f, g, h, i, j, k]) => [
      a,
      b,
      [...c],
      d,
      e,
      f,
      g,
      h.map(([a, b, c]) => [a, b, c]),
      i,
      j,
      [...k],
    ]),
    units: n.units.map(([a, b, c, d]) => [a, b, [...c], [...d]]),
    factAttributes: n.factAttributes.map(([a, b, c, d, e, f, g]) => [a, b, c, d, e, f, g]),
    facts: n.facts.map(([a, b, c, d, e, f, g, h]) => [a, b, c, d, e, f, g, h]),
    tables: n.tables.map(([a, b, c, d, e]) => [
      a,
      b,
      c,
      d.map(([a, b, c, meta]) =>
        meta ? [a, b, c, [meta[0], meta[1], meta[2], [...meta[3]], meta[4]]] : [a, b, c]
      ),
      e.map(([a, b, c]) => [a, b, c]),
    ]),
    passages: n.passages.map(([a, b, c, d]) => [a, b, c, d]),
    warnings: [...n.warnings],
  };
}
