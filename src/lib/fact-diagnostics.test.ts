import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateSavedFacts } from './fact-cache';
import { canonicalJSON } from './fact-contract';
import { chunkFactDiagnostics, FACT_DIAGNOSTIC_CHUNK_LENGTH } from './fact-diagnostics';
import { generateVerifiedFacts, parseFactSummary } from './fact-summary';
import { generateText } from './llm-client';
import { candidateResponse } from './fixtures/candidate-test-source';
import { numberCandidate, textPage } from './fixtures/v4-test-source';
import { buildPresentation, revalidatePresentation } from './summary-presentation';
import { summaryResultId } from './summary-result-id';
import type { SummaryAttempt } from './summary-trace';

vi.mock('./llm-client', () => ({ generateText: vi.fn() }));
const page = textPage(
  '会社名 株式会社テスト | 会計基準 日本基準 | 範囲 連結\n2026年3月期 連結経営成績\n営業利益は100百万円です。'
);
const facts = parseFactSummary(
  JSON.stringify({
    version: 6,
    documentType: 'other',
    facts: [numberCandidate(page)],
    unverified: [],
  }),
  'other',
  [page],
  false
);
const config = { provider: 'openai', model: 'fixture', apiKey: 'fixture' };

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('This diagnostic contract test must not access the network');
    })
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

describe('diagnostic production and legacy v6 persistence', () => {
  // Owns the former producer/save/reparse mismatch at the exact length boundary.
  it.each([1000, 1001, 2106])(
    'roundtrips a generated %i-character incomplete reason',
    async (size) => {
      const prefix = '候補の追加確認未完了: ';
      const apiError = 'x'.repeat(size - prefix.length);
      const reason = prefix + apiError;
      // A valid detail fact is retained, but is never promoted to a required key fact.
      vi.mocked(generateText)
        .mockResolvedValueOnce(
          candidateResponse([{ ...numberCandidate(page), importance: 'detail' }], [page])
        )
        .mockRejectedValueOnce(new Error(apiError));
      const attempts: SummaryAttempt[] = [];
      const generated = await generateVerifiedFacts(
        config,
        'other',
        'source',
        [page],
        (attempt) => {
          attempts.push(attempt);
        },
        true
      );
      expect(generated.repairAttempted).toBe(true);
      expect(generated.facts.facts).toMatchObject([{ importance: 'detail', value: 100 }]);
      expect(generated.facts.unverified).toEqual(chunkFactDiagnostics([reason]));
      expect(generated.facts.unverified.join('')).toBe(reason);
      expect(generated.facts.unverified.every((entry) => entry.length <= 1000)).toBe(true);
      expect(attempts.at(-1)?.error).toBe(apiError);

      const saved: unknown = JSON.parse(JSON.stringify(generated.facts));
      validateSavedFacts(saved);
      const restored = parseFactSummary(JSON.stringify(saved), 'other', [page], false);
      expect(restored).toEqual(generated.facts);
      expect(() => parseFactSummary(JSON.stringify(saved), 'other', [page])).toThrow('重要事実');
      expect(vi.mocked(generateText)).toHaveBeenCalledTimes(2);
    }
  );

  it.each([1000, 1001, 2106])(
    'preserves a legacy %i-character reason and its result identity',
    async (size) => {
      const cached = { ...facts, unverified: ['既存診断' + 'x'.repeat(size - 4)] };
      const original = canonicalJSON(cached);
      const presentation = buildPresentation(cached, [page]);
      validateSavedFacts(cached);
      const restored = parseFactSummary(JSON.stringify(cached), 'other', [page], false);
      expect(canonicalJSON(cached)).toBe(original);
      expect(canonicalJSON(restored)).toBe(original);
      const restoredPresentation = revalidatePresentation(presentation, restored, [page]);
      const identity = (value: typeof facts, display = presentation) =>
        summaryResultId(
          'https://www.release.tdnet.info/inbs/140120261010548129.pdf',
          'fixture-fingerprint',
          value,
          'a'.repeat(64),
          display
        );
      expect(await identity(restored, restoredPresentation)).toBe(await identity(cached));
      expect(generateText).not.toHaveBeenCalled();
    }
  );

  it('preserves repeated chunks and Unicode pairs without a new aggregate diagnostic cap', () => {
    const reason = 'x'.repeat(999) + '😀' + 'y'.repeat(10_001);
    const chunks = chunkFactDiagnostics([reason]);
    expect(chunks.join('')).toBe(reason);
    expect(chunks[0]).toHaveLength(999);
    expect(chunks[1].startsWith('😀')).toBe(true);
    expect(chunks.every((entry) => entry.length <= FACT_DIAGNOSTIC_CHUNK_LENGTH)).toBe(true);
    expect(chunkFactDiagnostics(chunks)).toEqual(chunks);
  });

  it('bounds diagnostics newly added by source revalidation without retaining an invalid fact', () => {
    const label = 'x'.repeat(2106);
    const restored = parseFactSummary(
      JSON.stringify({ ...facts, facts: [{ ...facts.facts[0], label }] }),
      'other',
      [page],
      false
    );
    expect(restored.facts).toEqual([]);
    expect(restored.unverified.join('')).toContain(label);
    expect(restored.unverified.every((entry) => entry.length <= 1000)).toBe(true);
    validateSavedFacts(restored);
    expect(parseFactSummary(JSON.stringify(restored), 'other', [page], false)).toEqual(restored);
  });

  it.each(
    [null, 'reason', [null], [1], [{}], [['reason']], [undefined], Array(1)].map((unverified) => ({
      unverified,
    }))
  )('rejects malformed reasons consistently: %j', ({ unverified }) => {
    const malformed = { ...facts, unverified };
    expect(() => validateSavedFacts(malformed)).toThrow('形式');
    expect(() => parseFactSummary(JSON.stringify(malformed), 'other', [page], false)).toThrow(
      '形式'
    );
    expect(() => chunkFactDiagnostics(unverified as string[])).toThrow('文字列');
    expect(generateText).not.toHaveBeenCalled();
  });
});
