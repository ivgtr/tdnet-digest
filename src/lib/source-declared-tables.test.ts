import { describe, expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import corpus from './fixtures/ir-semantic-corpus.json';
import { extractPageLayout } from './pdf-layout';
import { buildDocumentContext } from './document-context';
import { sourceDeclaredTables } from './source-declared-tables';
import { serializeCandidateSource } from './fact-candidates';
import { factPrompt } from './fact-summary';

const source = () =>
  corpus[0].pages.map((p) => extractPageLayout(p.items as TextItem[], p.pageNumber));

// These tests own additive selection guidance, not verifier coverage or metric aliases.
describe('source-declared table selection markers', () => {
  it('retains arbitrary metric names, source IDs and separate periods without mutating raw input', () => {
    const pages = source();
    pages[0].spans.find((s) => s.id === 'p1s54')!.text = '独自価値創出額';
    const before = JSON.stringify(pages);
    const context = buildDocumentContext(pages);
    const table = sourceDeclaredTables(pages, context).find((t) => t.tableId === 'p1t1')!;
    expect(table.selectionRole).toBe('financialPerformance');
    expect(table.metricAxes).toContainEqual({
      sourceIds: ['p1s54'],
      text: '独自価値創出額',
      valueIds: ['p1s73', 'p1s87'],
    });
    expect(table.periodAxes).toEqual([
      {
        sourceIds: ['p1s64', 'p1s65'],
        text: '2026年３月期',
        valueIds: ['p1s66', 'p1s70', 'p1s73', 'p1s76'],
      },
      {
        sourceIds: ['p1s78', 'p1s79'],
        text: '2025年３月期',
        valueIds: ['p1s80', 'p1s84', 'p1s87', 'p1s90'],
      },
    ]);
    expect(JSON.stringify(pages)).toBe(before);
    const serialized = JSON.parse(serializeCandidateSource(pages, context, 'earnings'));
    expect(serialized.sourceDeclaredTables).toContainEqual(table);
    expect(serialized.pages[0].spans).toContainEqual(
      expect.arrayContaining(['p1s54', '独自価値創出額'])
    );
    expect(serialized.pages[0].hints).toEqual(
      context.tableMappings.filter((m) => pages[0].quantities.some((q) => q.id === m.valueId))
    );
  });

  it('does not collapse identically named axes with different original IDs', () => {
    const pages = source();
    pages[0].spans.find((s) => s.id === 'p1s54')!.text = '営業利益';
    const table = sourceDeclaredTables(pages, buildDocumentContext(pages)).find(
      (t) => t.tableId === 'p1t1'
    )!;
    expect(table.metricAxes.filter((a) => a.text === '営業利益')).toEqual([
      { sourceIds: ['p1s53'], text: '営業利益', valueIds: ['p1s70', 'p1s84'] },
      { sourceIds: ['p1s54'], text: '営業利益', valueIds: ['p1s73', 'p1s87'] },
    ]);
  });

  it('keeps a pretax heading verbatim and exposes unresolved table text without promoting it', () => {
    const pages = source();
    pages[0].spans.find((s) => s.id === 'p1s54')!.text = '税引前利益';
    const context = buildDocumentContext(pages);
    const table = sourceDeclaredTables(pages, context).find((t) => t.tableId === 'p1t1')!;
    expect(table.metricAxes.find((a) => a.sourceIds.includes('p1s54'))!.text).toBe('税引前利益');
    context.tableMappings = context.tableMappings.filter((m) => !m.metricIds.includes('p1s54'));
    const unresolved = sourceDeclaredTables(pages, context).find((t) => t.tableId === 'p1t1')!;
    expect(unresolved.unresolvedText).toContainEqual({ id: 'p1s54', text: '税引前利益' });
    expect(unresolved.unmappedValueIds).toEqual(expect.arrayContaining(['p1s73', 'p1s87']));
    expect(unresolved.metricAxes.some((a) => a.text === '経常利益')).toBe(false);
  });

  it('keeps supplemental tables and instructs that markers neither exhaust nor expand obligations', () => {
    const pages = source();
    const markers = sourceDeclaredTables(pages, buildDocumentContext(pages));
    expect(markers.find((t) => t.tableId === 'p1t3')!.selectionRole).toBe('sourceTable');
    const prompt = factPrompt('earnings', '').system;
    expect(prompt).toContain('重要項目の全一覧ではありません');
    expect(prompt).toContain('未知の名称や中間的な利益段階');
    expect(prompt).toContain('補足表の全セルを一律に必須にはせず');
  });
});
