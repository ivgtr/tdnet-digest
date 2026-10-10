import { createRequire } from 'node:module';
import { Zip, ZipDeflate, strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  NATIVE_LIMITS,
  nativeDisclosureChecksum,
  nativeDisclosureModelInput,
  projectNativeModelInput,
  parseNativeDisclosureArchive,
  validateNativeCompanionRef,
  validateNativeDisclosure,
} from './native-disclosure';
import {
  fixturePeriods,
  nativeFixtureContext,
  nativeFixtureFiles,
  nativeFixturePaths as paths,
  nativeFixturePdfText,
  nativeFixtureRef,
  verifiedNativeCases,
  type NativeFixtureCase,
} from './fixtures/native-disclosure-source';

// Node retains its real WebCrypto; only the inert XML APIs come from JSDOM.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (
    html: string,
    options: { runScripts: 'dangerously' }
  ) => {
    window: Window & typeof globalThis;
  };
};
const dom = new JSDOM('', { runScripts: 'dangerously' });
const noNetwork = vi.fn(() => {
  throw new Error('Offline native-disclosure test');
});
beforeAll(() => {
  vi.stubGlobal('DOMParser', dom.window.DOMParser);
  vi.stubGlobal('XMLSerializer', dom.window.XMLSerializer);
  vi.stubGlobal('fetch', noNetwork);
});
afterAll(() => {
  expect(noNetwork).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  dom.window.close();
});

const archive = (files = nativeFixtureFiles()) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
const parse = (files = nativeFixtureFiles(), which: NativeFixtureCase = 'cando') =>
  parseNativeDisclosureArchive(archive(files), nativeFixtureRef(which), {
    pdfText: nativeFixturePdfText(which),
  });

// Owns exact source representation, document-set provenance and eligibility. It does
// not assert model correctness or promote company statements into verified facts.
describe('native disclosure source and provenance', () => {
  it.each(['cando', 'yaskawa'] as const)(
    'preserves every independently checked %s value and its period/unit',
    async (which) => {
      const source = await parse(nativeFixtureFiles(which), which);
      expect(source.status).toBe('eligible');
      expect(source.reasons).toEqual([]);
      expect(source.consistency).toEqual({ pdfIdentity: 'matched', numeric: 'not-compared' });
      expect(source.hash).toMatch(/^[a-f0-9]{64}$/);
      let checked = 0;
      for (const metric of verifiedNativeCases[which].metrics) {
        const facts = source.facts.filter((f) => f.concept.localName === metric.concept);
        expect(facts).toHaveLength(3);
        for (const [index, period] of fixturePeriods.entries()) {
          const fact = facts.find(
            (f) => source.contexts.find((c) => c.id === f.contextId)?.period.end === period.end
          )!;
          expect(fact).toMatchObject({
            file: paths.summary,
            literal: metric.values[index],
            value: metric.expected[index],
            status: 'parsed',
            scale: metric.eps ? 0 : 6,
            decimals: metric.eps ? '2' : '-6',
            sign: null,
          });
          expect(source.contexts.find((c) => c.id === fact.contextId)).toMatchObject({
            entity: {
              identifier: verifiedNativeCases[which].code,
              scheme: 'http://www.tse.or.jp/sicc',
            },
            period: { start: period.start, end: period.end, instant: null },
            valueKind: period.state === 'ForecastMember' ? 'forecast' : 'actual',
            consolidation: 'consolidated',
          });
          expect(source.units.find((u) => u.id === fact.unitId)).toMatchObject({
            numerator: ['{http://www.xbrl.org/2003/iso4217}JPY'],
            denominator: metric.eps ? ['{http://www.xbrl.org/2003/instance}shares'] : [],
          });
          const table = source.tables.find((t) => t.id === fact.tableId)!;
          expect(table.cells.find((c) => c.id === fact.cellId)?.text).toBe(metric.values[index]);
          expect(fact.rowText).toContain(metric.label);
          checked++;
        }
      }
      expect(checked).toBe(which === 'cando' ? 15 : 3);
      const model = nativeDisclosureModelInput(source);
      expect(model).toMatchObject({
        sourceKind: 'tdnet-native',
        evidenceStatus: 'company-source-unreviewed',
      });
      expect(model.facts).toHaveLength(source.facts.length);
      expect(model.contexts).toHaveLength(source.contexts.length);
      expect(model.tables).toHaveLength(source.tables.length);
      expect(model.passages).toHaveLength(source.passages.length);
      const expandedQName = (index: number) => {
        const [namespace, localName] = model.qnames[index];
        return `{${model.namespaces[namespace]}}${localName}`;
      };
      const fileOrdinals = new Map<number, number>();
      for (const [index, fact] of source.facts.entries()) {
        const encoded = model.facts[index];
        const attributes = model.factAttributes[encoded[3]];
        const ordinal = (fileOrdinals.get(encoded[0]) ?? 0) + 1;
        fileOrdinals.set(encoded[0], ordinal);
        expect(`${model.files[encoded[0]]}#fact-${ordinal}`).toBe(fact.id);
        expect(model.texts[encoded[4]]).toBe(fact.literal);
        expect(
          attributes[1] === 'text' && typeof encoded[5] === 'number'
            ? model.texts[encoded[5]]
            : encoded[5]
        ).toBe(fact.value);
        expect(attributes.slice(1, 6)).toEqual([
          fact.kind,
          fact.status,
          fact.scale,
          fact.sign,
          fact.decimals,
        ]);
        expect(attributes[6] === null ? null : expandedQName(attributes[6])).toBe(fact.format);
        const context = model.contexts[encoded[2]];
        expect(`${model.documentSets[context[0]]}#${context[1]}`).toBe(fact.contextId);
        expect(model.documentSets[context[0]]).toBe(fact.documentSetId);
        if (attributes[0] !== null) {
          const unit = model.units[attributes[0]];
          expect(`${model.documentSets[unit[0]]}#${unit[1]}`).toBe(fact.unitId);
        } else expect(fact.unitId).toBeNull();
        const concept = model.concepts[encoded[1]];
        expect([
          (concept[0] ? concept[0] + ':' : '') + concept[2],
          model.namespaces[concept[1]],
          concept[2],
        ]).toEqual([fact.concept.qname, fact.concept.namespace, fact.concept.localName]);
        if (encoded[6] !== null && encoded[7] !== null) {
          const table = model.tables[encoded[6]];
          const cell = table[3][encoded[7]];
          expect(`${model.files[table[0]]}#${table[1]}`).toBe(fact.tableId);
          expect(`${model.files[table[0]]}#${table[1]}:r${cell[0] + 1}c${cell[1] + 1}`).toBe(
            fact.cellId
          );
          const row = table[4].find((r) => r[0] === cell[0])!;
          expect(
            table[3]
              .slice(row[1], row[1] + row[2])
              .map((c) => model.texts[c[2]])
              .join(' | ')
          ).toBe(fact.rowText);
        } else expect([fact.tableId, fact.cellId, fact.rowText]).toEqual([null, null, null]);
      }
      expect(model.units).toHaveLength(source.units.length);
      for (const [index, unit] of source.units.entries()) {
        const encoded = model.units[index];
        expect(`${model.documentSets[encoded[0]]}#${encoded[1]}`).toBe(unit.id);
        expect(encoded[2].map(expandedQName)).toEqual(unit.numerator);
        expect(encoded[3].map(expandedQName)).toEqual(unit.denominator);
      }
      for (const [index, context] of source.contexts.entries()) {
        const encoded = model.contexts[index];
        expect(encoded[2].map((i) => model.files[i])).toEqual(context.sourceFiles);
        expect(model.entities[encoded[3]]).toEqual([
          context.entity.identifier,
          context.entity.scheme,
        ]);
        expect(encoded.slice(4, 7)).toEqual([
          context.period.start,
          context.period.end,
          context.period.instant,
        ]);
        expect(encoded.slice(8, 10)).toEqual([context.valueKind, context.consolidation]);
        expect(encoded[10].map((i) => model.texts[i])).toEqual(context.otherContent);
        expect(
          encoded[7].map(([axis, member, typedValue]) => ({
            axis: expandedQName(axis),
            member: member === null ? null : expandedQName(member),
            typedValue: typedValue === null ? null : model.texts[typedValue],
          }))
        ).toEqual(context.dimensions);
      }
      for (const [index, table] of source.tables.entries()) {
        const encoded = model.tables[index];
        expect(encoded[3]).toHaveLength(table.cells.length);
        expect(encoded[4]).toHaveLength(table.rows.length);
        expect(encoded[2] === null ? null : model.texts[encoded[2]]).toBe(table.caption);
        for (const [cellIndex, cell] of table.cells.entries()) {
          const encodedCell = encoded[3][cellIndex];
          const metadata = encodedCell[3] ?? [1, 1, 'td', [], null];
          expect(encodedCell.slice(0, 2)).toEqual([cell.row, cell.column]);
          expect(metadata).toEqual([
            cell.rowSpan,
            cell.colSpan,
            cell.tag,
            cell.headers,
            cell.scope,
          ]);
          expect(model.texts[encodedCell[2]]).toBe(cell.text);
          expect(`${table.id}:r${encodedCell[0] + 1}c${encodedCell[1] + 1}`).toBe(cell.id);
        }
        for (const [rowIndex, row] of table.rows.entries()) {
          const encodedRow = encoded[4][rowIndex];
          const cells = encoded[3].slice(encodedRow[1], encodedRow[1] + encodedRow[2]);
          expect(cells.map((c) => model.texts[c[2]]).join(' | ')).toBe(row.text);
          expect(cells.map((c) => `${table.id}:r${c[0] + 1}c${c[1] + 1}`)).toEqual(row.cellIds);
          expect(`${table.id}:r${encodedRow[0] + 1}`).toBe(row.id);
        }
      }
      expect(model.passages.map((p) => model.texts[p[3]])).toEqual(
        source.passages.map((p) => p.text)
      );
    }
  );

  it('retains signed decimal scale and nil without replacing the missing value with zero', async () => {
    const source = await parse();
    expect(
      source.facts.find((f) => f.concept.localName === 'ChangeInOperatingIncome')
    ).toMatchObject({
      literal: '24.7',
      sign: '-',
      scale: -2,
      decimals: '3',
      value: '-0.247',
      status: 'parsed',
    });
    expect(source.facts.find((f) => f.concept.localName === 'UnknownForecastBound')).toMatchObject({
      literal: '',
      value: null,
      status: 'nil',
      scale: 6,
      decimals: '-6',
    });
  });

  it('resolves manifest cross-file definitions and isolates the same context ID in Summary', async () => {
    const files = nativeFixtureFiles();
    files[paths.definitions] = files[paths.definitions].replace('2026-03-01', '2026-06-01');
    const source = await parse(files);
    const unknown = source.facts.find((f) => f.concept.localName === 'UnknownPublicMetric')!;
    expect(unknown).toMatchObject({
      file: paths.statement,
      value: '876000000',
      status: 'parsed',
      concept: {
        qname: 'ext:UnknownPublicMetric',
        namespace: 'https://example.test/public-fixture-taxonomy',
      },
    });
    const attachmentContext = source.contexts.find((c) => c.id === unknown.contextId)!;
    expect(attachmentContext).toMatchObject({
      sourceFiles: [paths.definitions],
      period: { start: '2026-06-01' },
    });
    expect(source.documents.find((d) => d.file === paths.statement)?.documentSetId).toBe(
      attachmentContext.documentSetId
    );
    const sales = source.facts.find((f) => f.concept.localName === 'NetSales')!;
    expect(source.contexts.find((c) => c.id === sales.contextId)).toMatchObject({
      sourceFiles: [paths.summary],
      period: { start: '2026-03-01' },
    });
    expect(sales.contextId).not.toBe(unknown.contextId);
    expect(sales.documentSetId).not.toBe(unknown.documentSetId);
  });

  it('rejects conflicting duplicate definitions inside the same manifest document set', async () => {
    const files = nativeFixtureFiles();
    files[paths.statement] = files[paths.statement].replace(
      '<body>',
      `<body>${nativeFixtureContext('current', '26980', '2026-06-01')}`
    );
    await expect(parse(files)).rejects.toThrow(/文脈定義が矛盾/);
  });

  it.each([
    ['invalid calendar date', '2026-02-30'],
    ['reversed duration', '2026-09-01'],
  ])('rejects %s before assigning a financial period', async (_name, start) => {
    const files = nativeFixtureFiles();
    files[paths.definitions] = files[paths.definitions].replace('2026-03-01', start);
    await expect(parse(files)).rejects.toThrow(/文脈の期間/);
  });

  it('does not interpret a shadow-namespace ResultMember as the official actual-result dimension', async () => {
    const files = nativeFixtureFiles();
    files[paths.summary] = files[paths.summary].replace('>tse:ResultMember<', '>ext:ResultMember<');
    const source = await parse(files);
    const fact = source.facts.find((f) => f.concept.localName === 'NetSales')!;
    const context = source.contexts.find((c) => c.id === fact.contextId)!;
    expect(context.valueKind).toBeNull();
    expect(
      context.dimensions.some(
        (d) => d.member === '{https://example.test/public-fixture-taxonomy}ResultMember'
      )
    ).toBe(true);
  });

  it('retains unrecognized segment and scenario qualifiers in source and model context', async () => {
    const files = nativeFixtureFiles();
    files[paths.summary] = files[paths.summary]
      .replace(
        '</xbrli:entity>',
        '<xbrli:segment><ext:ScopeQualifier>国内事業のみ</ext:ScopeQualifier></xbrli:segment></xbrli:entity>'
      )
      .replace(
        '</xbrli:scenario>',
        '<ext:MeasurementQualifier basis="provisional">暫定集計</ext:MeasurementQualifier></xbrli:scenario>'
      );
    const source = await parse(files);
    const fact = source.facts.find((f) => f.concept.localName === 'NetSales')!;
    const index = source.contexts.findIndex((c) => c.id === fact.contextId);
    const context = source.contexts[index];
    expect(context.otherContent).toHaveLength(2);
    expect(context.otherContent[0]).toContain('ext:ScopeQualifier');
    expect(context.otherContent[0]).toContain('国内事業のみ');
    expect(context.otherContent[1]).toContain('basis="provisional"');
    expect(context.otherContent[1]).toContain('暫定集計');
    expect(context.dimensions).toHaveLength(2);
    const model = nativeDisclosureModelInput(source);
    expect(model.contexts[index][10].map((i) => model.texts[i])).toEqual(context.otherContent);
    expect(validateNativeDisclosure(source)).toEqual(source);
  });

  it('applies supported boolean transforms to blank literals and retains unknown transforms as unsupported', async () => {
    const files = nativeFixtureFiles();
    files[paths.summary] = files[paths.summary].replace(
      '</body>',
      '<p><ix:nonNumeric name="ext:FlagTrue" contextRef="current" format="ixt:booleantrue" />' +
        '<ix:nonNumeric name="ext:FlagFalse" contextRef="current" format="ixt:booleanfalse" />' +
        '<ix:nonNumeric name="ext:UnknownText" contextRef="current" format="ext:booleantrue">original text</ix:nonNumeric></p></body>'
    );
    const source = await parse(files);
    expect(source.facts.find((f) => f.concept.localName === 'FlagTrue')).toMatchObject({
      literal: '',
      value: 'true',
      status: 'parsed',
    });
    expect(source.facts.find((f) => f.concept.localName === 'FlagFalse')).toMatchObject({
      literal: '',
      value: 'false',
      status: 'parsed',
    });
    expect(source.facts.find((f) => f.concept.localName === 'UnknownText')).toMatchObject({
      literal: 'original text',
      value: null,
      status: 'unsupported',
    });
    expect(validateNativeDisclosure(source)).toEqual(source);
  });

  it('rejects unresolved context references instead of borrowing one from Summary', async () => {
    const files = nativeFixtureFiles();
    files[paths.statement] = files[paths.statement].replace(
      'contextRef="current"',
      'contextRef="prior"'
    );
    await expect(parse(files)).rejects.toThrow(/文脈または単位の参照/);
  });

  it.each([
    'foreign issuer',
    'stale filing date',
    'correction',
    'missing PDF text',
    'mismatched PDF issuer',
  ] as const)('marks %s ineligible while retaining the original source', async (reason) => {
    const files = nativeFixtureFiles();
    const ref = nativeFixtureRef();
    if (reason === 'foreign issuer')
      files[paths.definitions] = files[paths.definitions].replace('26980', '65060');
    if (reason === 'stale filing date')
      files[paths.summary] = files[paths.summary].replace('2026年10月9日', '2026年10月8日');
    if (reason === 'correction') ref.correction = true;
    const source = await parseNativeDisclosureArchive(
      archive(files),
      ref,
      reason === 'missing PDF text'
        ? {}
        : {
            pdfText: nativeFixturePdfText(reason === 'mismatched PDF issuer' ? 'yaskawa' : 'cando'),
          }
    );
    expect(source.status).toBe('ineligible');
    expect(source.reasons.length).toBeGreaterThan(0);
    expect(source.facts.some((f) => f.value === '44743000000')).toBe(true);
    expect(source.consistency.numeric).toBe('not-compared');
    if (reason === 'missing PDF text') expect(source.consistency.pdfIdentity).toBe('unverified');
    expect(validateNativeDisclosure(source)).toEqual(source);
    expect(() => nativeDisclosureModelInput(source)).toThrow(/NATIVE:/);
    if (reason === 'mismatched PDF issuer') expect(source.consistency.pdfIdentity).toBe('mismatch');
  });

  it('requires an explicit matching companion reference and cannot erase a correction marker', () => {
    expect(() => validateNativeCompanionRef(undefined)).toThrow(/同じ開示行/);
    expect(() =>
      validateNativeCompanionRef(nativeFixtureRef(), nativeFixtureRef('yaskawa').pdfUrl)
    ).toThrow(/一致しません/);
    expect(() =>
      validateNativeCompanionRef({ ...nativeFixtureRef(), title: '（訂正）決算短信' })
    ).toThrow(/訂正開示/);
  });

  it('does not silently truncate long unclassified prose or late table rows for model input', async () => {
    const files = nativeFixtureFiles();
    const prose = '補足の原文。'.repeat(3000) + '末尾まで残す。';
    const rows = Array.from(
      { length: 205 },
      (_, index) => `<tr><td>原文項目${index}</td><td>${index}</td></tr>`
    ).join('');
    files[paths.qualitative] = files[paths.qualitative].replace(
      '</body>',
      `<p>${prose}</p><table>${rows}</table></body>`
    );
    const source = await parse(files);
    const model = nativeDisclosureModelInput(source);
    expect(model.passages.map((p) => model.texts[p[3]])).toContain(prose);
    const original = source.tables[source.tables.length - 1];
    const encoded = model.tables[model.tables.length - 1];
    expect(encoded[4]).toHaveLength(205);
    expect(
      encoded[4].map((row) =>
        encoded[3]
          .slice(row[1], row[1] + row[2])
          .map((cell) => model.texts[cell[2]])
          .join(' | ')
      )
    ).toEqual(original.rows.map((row) => row.text));
    expect(model.texts).toContain('原文項目204');
  });

  it('retains unclassified visible text outside the recognized paragraph containers', async () => {
    const files = nativeFixtureFiles();
    files[paths.qualitative] = files[paths.qualitative].replace(
      '</body>',
      '<section><span>独自形式の注記も保持する。</span></section></body>'
    );
    const source = await parse(files);
    expect(source.passages.some((p) => p.text === '独自形式の注記も保持する。')).toBe(true);
    expect(nativeDisclosureModelInput(source).texts).toContain('独自形式の注記も保持する。');
  });

  it('projects only allowlisted source fields from both full and compact inputs', async () => {
    const source = await parse();
    const contaminated = Object.assign(structuredClone(source), {
      injected: 'do-not-forward-fixture',
    });
    Object.assign(contaminated.source, { injected: 'do-not-forward-fixture' });
    Object.assign(contaminated.facts[0], { injected: 'do-not-forward-fixture' });
    const projected = projectNativeModelInput(contaminated);
    expect(projected).toEqual(nativeDisclosureModelInput(source));
    const compact = Object.assign(projected, { injected: 'do-not-forward-fixture' });
    Object.assign(compact.source, { injected: 'do-not-forward-fixture' });
    expect(JSON.stringify(projectNativeModelInput(compact))).not.toContain(
      'do-not-forward-fixture'
    );
  });

  it('rechecks persisted values, context semantics and redundant row content after checksum recomputation', async () => {
    const source = await parse();
    expect(validateNativeDisclosure(JSON.parse(JSON.stringify(source)))).toEqual(source);
    const changed = structuredClone(source);
    changed.facts.find((f) => f.concept.localName === 'NetSales')!.value = '43372000000';
    expect(() => validateNativeDisclosure(changed)).toThrow(/保存された/);
    const { checksum, ...body } = changed;
    expect(checksum).toBe(source.checksum);
    changed.checksum = nativeDisclosureChecksum(body);
    expect(() => validateNativeDisclosure(changed)).toThrow(/保存された/);
    const mutations: Array<(value: typeof source) => void> = [
      (value) => {
        value.contexts[0].period.end = '2026-02-31';
      },
      (value) => {
        value.contexts[0].valueKind = 'forecast';
      },
      (value) => {
        value.facts.find((f) => f.tableId !== null)!.rowText = '別の行';
      },
      (value) => {
        value.facts.find((f) => f.kind === 'number')!.value = null;
      },
    ];
    for (const mutate of mutations) {
      const altered = structuredClone(source);
      mutate(altered);
      const { checksum: oldChecksum, ...payload } = altered;
      expect(oldChecksum).toBe(source.checksum);
      altered.checksum = nativeDisclosureChecksum(payload);
      expect(() => validateNativeDisclosure(altered)).toThrow(/保存された/);
    }
  });
});

// ZIP checks own archive integrity/resource limits before XML reaches any consumer.
// Tiny header mutations exercise declared-size limits without an allocation bomb.
describe('bounded inert native archive input', () => {
  const mutateZip = (mutate: (view: DataView, central: number, end: number) => void) => {
    const bytes = archive();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.length - 22;
    mutate(view, view.getUint32(end + 16, true), end);
    return bytes;
  };
  const invalidArchives: Array<[string, () => Uint8Array]> = [
    ['path traversal', () => archive({ ...nativeFixtureFiles(), '../outside.xml': '<outside />' })],
    [
      'case-aliased duplicate',
      () =>
        archive({
          ...nativeFixtureFiles(),
          [paths.summary.toUpperCase()]: nativeFixtureFiles()[paths.summary],
        }),
    ],
    [
      'encrypted entry',
      () =>
        mutateZip((view, central) => {
          view.setUint16(6, view.getUint16(6, true) | 1, true);
          view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true);
        }),
    ],
    [
      'CRC mismatch',
      () =>
        mutateZip((view, central) => {
          const forged = view.getUint32(central + 16, true) ^ 1;
          view.setUint32(14, forged, true);
          view.setUint32(central + 16, forged, true);
        }),
    ],
    ['truncated archive', () => archive().slice(0, -12)],
    [
      'oversized declared entry',
      () =>
        mutateZip((view, central) => {
          view.setUint32(22, NATIVE_LIMITS.entryBytes + 1, true);
          view.setUint32(central + 24, NATIVE_LIMITS.entryBytes + 1, true);
        }),
    ],
    [
      'too many declared entries',
      () =>
        mutateZip((view, _central, end) => {
          view.setUint16(end + 8, NATIVE_LIMITS.entries + 1, true);
          view.setUint16(end + 10, NATIVE_LIMITS.entries + 1, true);
        }),
    ],
  ];
  it.each(invalidArchives)(
    'refuses %s before treating archive data as source',
    async (_name, make) => {
      await expect(
        parseNativeDisclosureArchive(make(), nativeFixtureRef(), {
          pdfText: nativeFixturePdfText(),
        })
      ).rejects.toThrow(/NATIVE:/);
    }
  );

  it('accepts a valid deflate data descriptor used by actual TDnet ZIPs', async () => {
    const chunks: Uint8Array[] = [];
    const zip = new Zip((error, data) => {
      if (error) throw error;
      chunks.push(data);
    });
    const file = new ZipDeflate(paths.summary);
    zip.add(file);
    file.push(strToU8(nativeFixtureFiles()[paths.summary]), true);
    zip.end();
    const bytes = new Uint8Array(chunks.reduce((length, chunk) => length + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    expect(new DataView(bytes.buffer).getUint16(6, true) & 8).toBe(8);
    expect(
      (
        await parseNativeDisclosureArchive(bytes, nativeFixtureRef(), {
          pdfText: nativeFixturePdfText(),
        })
      ).status
    ).toBe('eligible');
  });

  it('refuses external entity declarations even in an unconsumed taxonomy file', async () => {
    const files = {
      ...nativeFixtureFiles(),
      'XBRLData/Attachment/taxonomy.xsd':
        '<!DOCTYPE schema [<!ENTITY external SYSTEM "https://example.test/private">]><schema>&external;</schema>',
    };
    await expect(parse(files)).rejects.toThrow(/DTD・外部エンティティ/);
    expect(noNetwork).not.toHaveBeenCalled();
  });

  it('keeps merged headers, separate amount/rate rows and prose as inert source text', async () => {
    const files = nativeFixtureFiles();
    files[paths.qualitative] = files[paths.qualitative].replace(
      '</body>',
      '<p>安全な説明 <a href="https://example.test/external">外部資料</a><img src="https://example.test/image" onerror="window.nativeScriptRan = true" />' +
        '<script>window.nativeScriptRan = true; fetch("https://example.test/run")</script></p></body>'
    );
    const scriptState = dom.window as unknown as { nativeScriptRan?: boolean };
    delete scriptState.nativeScriptRan;
    const source = await parse(files);
    expect(scriptState.nativeScriptRan).toBeUndefined();
    expect(noNetwork).not.toHaveBeenCalled();
    const texts = source.passages.map((p) => p.text);
    expect(texts).toContain('安全な説明 外部資料');
    expect(texts).toContain('FC店への卸売上高49億4百万円、その他売上高7億96百万円となりました。');
    expect(texts.join(' ')).not.toMatch(/nativeScriptRan|https:\/\/example|fetch\(/);
    const summary = source.tables.find((t) => t.file === paths.summary)!;
    expect(summary.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: '指標', row: 0, column: 0, rowSpan: 2, colSpan: 1 }),
        expect.objectContaining({ text: '中間期実績', row: 0, column: 1, rowSpan: 1, colSpan: 2 }),
        expect.objectContaining({ text: '当期', row: 1, column: 1 }),
        expect.objectContaining({ text: '前期', row: 1, column: 2 }),
      ])
    );
    const revision = source.tables.find((t) => t.file === paths.qualitative)!;
    expect(revision.rows.map((r) => r.text)).toEqual([
      '項目 | 税引前利益',
      '前回予想 | 65,000',
      '今回予想 | 65,500',
      '増減率（％） | 0.8',
    ]);
    expect(revision.rows[2].cellIds).not.toEqual(revision.rows[3].cellIds);
  });
});
