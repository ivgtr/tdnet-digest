import { describe, expect, it } from 'vitest';
import { verifyTableEvidence, type NumericClaim, type TableEvidence } from './numeric-evidence';
import type { PdfSpan } from './pdf-layout';
import type { ExtractedPage } from '@/types/summaryMetadata';

const span = (id: string, text: string, x: number, y: number, width = 40): PdfSpan => ({
  id,
  text,
  x,
  y,
  width,
  height: 10,
});
const spans = [
  span('context', '2027年5月期 業績予想', 0, 0, 280),
  span('m1', '独自KPI', 200, 20),
  span('m2', '営業利益', 300, 20),
  span('u1', '百万円', 200, 40),
  span('u2', '百万円', 300, 40),
  span('r1', '通期', 0, 60),
  span('v1', '100', 205, 60, 30),
  span('v2', '200', 305, 60, 30),
  span('r2', '第2四半期', 0, 80, 80),
  span('v3', '50', 210, 80, 20),
  span('v4', '100', 305, 80, 30),
];
const page: ExtractedPage = { pageNumber: 1, text: '', spans };
const evidence: TableEvidence = {
  valueId: 'v2',
  metricIds: ['m2'],
  periodIds: ['r1'],
  unitIds: ['u2'],
  contextIds: ['context'],
};
const claim: NumericClaim = {
  label: '営業利益',
  value: 200,
  unit: '百万円',
  period: '2027年5月期通期',
  valueKind: 'forecast',
};

describe('指標名と列順序に依存しない根拠検証', () => {
  it('未知の指標名でも根拠の対応を検証する', () => {
    expect(
      verifyTableEvidence(
        page,
        { ...evidence, valueId: 'v1', metricIds: ['m1'], unitIds: ['u1'] },
        { ...claim, label: '独自KPI', value: 100 }
      ).quote
    ).toContain('独自KPI');
  });
  it('列を入れ替えても同じ事実を得る', () => {
    const swapped = {
      ...page,
      spans: spans.map((s) => ({ ...s, x: s.x >= 300 ? s.x - 100 : s.x >= 200 ? s.x + 100 : s.x })),
    };
    expect(verifyTableEvidence(swapped, evidence, claim).quote).toBe(
      verifyTableEvidence(page, evidence, claim).quote
    );
  });
  it('新しい列を追加しても既存の指標を取り違えない', () => {
    const source = {
      ...page,
      spans: spans.concat(
        span('m3', '任意の指標', 400, 20),
        span('u3', '百万円', 400, 40),
        span('v5', '999', 405, 60, 30)
      ),
    };
    expect(verifyTableEvidence(source, evidence, claim).quote).toBe(
      verifyTableEvidence(page, evidence, claim).quote
    );
  });
  it('期間と分かれた予想表記を落として実績と判断できない', () => {
    const source = { ...page, spans: spans.concat(span('kind', '(予想)', 60, 60)) };
    expect(() => verifyTableEvidence(source, evidence, { ...claim, valueKind: 'actual' })).toThrow(
      '一部が未参照'
    );
  });
  it('見出しの改行を参照群から復元する', () => {
    const split = {
      ...page,
      spans: spans
        .filter((s) => s.id !== 'm2')
        .concat(span('m2a', '営業', 310, 20, 20), span('m2b', '利益', 310, 30, 20)),
    };
    expect(
      verifyTableEvidence(split, { ...evidence, metricIds: ['m2b', 'm2a'] }, claim).quote
    ).toContain('営業\n利益');
    expect(() =>
      verifyTableEvidence(split, { ...evidence, metricIds: ['m2b'] }, { ...claim, label: '利益' })
    ).toThrow('一部が未参照');
  });
  it('同額でも指標・期間の異なるセルを拒否する', () => {
    expect(() =>
      verifyTableEvidence(page, { ...evidence, valueId: 'v1' }, { ...claim, value: 100 })
    ).toThrow('単位の列');
    expect(() =>
      verifyTableEvidence(page, { ...evidence, valueId: 'v4' }, { ...claim, value: 100 })
    ).toThrow('期間');
  });
  it('空欄と欠損はゼロにせず、他列の照合を維持する', () => {
    for (const missing of ['', '－']) {
      const source = {
        ...page,
        spans: spans.map((s) => (s.id === 'v1' ? { ...s, text: missing } : s)),
      };
      expect(verifyTableEvidence(source, evidence, claim).evidence.valueId).toBe('v2');
      expect(() =>
        verifyTableEvidence(
          source,
          { ...evidence, valueId: 'v1', metricIds: ['m1'], unitIds: ['u1'] },
          { ...claim, label: '独自KPI', value: 0 }
        )
      ).toThrow('値・符号');
    }
  });
  it('指標が行、期間が列にある表を同じ形式で照合する', () => {
    const source: ExtractedPage = {
      pageNumber: 1,
      text: '',
      spans: [
        span('p1', '2027年5月期', 180, 0, 80),
        span('p2', '2026年5月期', 280, 0, 80),
        span('u1', '百万円', 200, 20),
        span('u2', '百万円', 300, 20),
        span('metric', '営業利益', 0, 40, 80),
        span('v1', '200', 205, 40, 30),
        span('v2', '100', 305, 40, 30),
      ],
    };
    const refs = {
      valueId: 'v1',
      metricIds: ['metric'],
      periodIds: ['p1'],
      unitIds: ['u1'],
      contextIds: [],
    };
    expect(
      verifyTableEvidence(source, refs, { ...claim, period: '2027年5月期', valueKind: 'actual' })
        .quote
    ).toContain('200');
    expect(() =>
      verifyTableEvidence(
        source,
        { ...refs, periodIds: ['p2'] },
        { ...claim, period: '2026年5月期', valueKind: 'actual' }
      )
    ).toThrow('期間');
  });
  it('単位・対象年度・通常予想と修正後予想の混同を拒否する', () => {
    for (const change of [
      { unit: '億円' },
      { period: '2026年5月期通期' },
      { valueKind: 'forecastAfter' },
    ]) {
      expect(() => verifyTableEvidence(page, evidence, { ...claim, ...change })).toThrow();
    }
  });
});
