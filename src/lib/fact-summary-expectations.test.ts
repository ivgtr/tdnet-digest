import { describe, expect, it } from 'vitest';
import {
  expectedErrors,
  independentAssessment,
  type Case,
} from '../../evaluation/scripts/fact-summary-expectations';
import golden from './fixtures/ir-semantic-expectations.json';
import type { VerifiedFact } from './fact-contract';
const base = structuredClone(golden[0].facts[0]) as unknown as VerifiedFact;
const item: Case = {
  id: 'oracle',
  title: '予想修正',
  documentType: 'earningsRevision',
  url: 'https://example.com/source.pdf',
  expected: [],
  expectedRanges: [
    {
      labels: [base.label],
      periods: [base.period!],
      lower: 670,
      upper: 800,
      unit: base.unit!,
      page: base.page,
      semantics: { subject: base.semantics.subject, state: 'forecastBefore' },
    },
  ],
};
const ranged: VerifiedFact = {
  ...base,
  kind: 'range',
  value: null,
  quantity: { raw: '670～800', decimal: null, lower: '670', upper: '800', sourceIds: ['p1s1'] },
  semantics: { ...base.semantics, state: 'forecastBefore' },
};
describe('製品hintに依存しない重要事実の評価', () => {
  it('範囲全体を要求し、片側の確定値や別主体で代用しない', () => {
    expect(expectedErrors(item, { facts: [ranged] })).toEqual([]);
    expect(
      expectedErrors(item, { facts: [{ ...ranged, kind: 'number', value: 670 }] })
    ).toHaveLength(1);
    expect(
      expectedErrors(item, {
        facts: [{ ...ranged, semantics: { ...ranged.semantics, subject: '株式会社他社' } }],
      })
    ).toHaveLength(1);
  });
  it('重要欠落と拒否診断を分けても元の厳格合否は維持する', () => {
    expect(
      independentAssessment(item, { facts: [ranged], unverified: ['任意候補を拒否'] })
    ).toEqual({
      missingFacts: [],
      diagnostics: ['任意候補を拒否'],
      importantFactsSatisfied: true,
      strictSuccess: false,
    });
    expect(independentAssessment(item, { facts: [] }).importantFactsSatisfied).toBe(false);
  });
  it('条件の原文eventを省くことは数値の充足やモデルのimportanceで補えない', () => {
    const critical: Case = {
      ...item,
      expectedEvidence: [
        {
          page: 1,
          blockId: 'p1b20',
          kind: 'event',
          semantics: { subject: base.semantics.subject },
        },
      ],
    };
    expect(expectedErrors(critical, { facts: [ranged] }).join(' ')).toContain('重要事項が不足');
  });
  it('重要条件は原文に対して要求し、独立eventやimportanceを必要条件にしない', () => {
    const text = '市場動向等により一部又は全部の取得が行われない可能性もある。';
    const critical: Case = { ...item, expectedConditions: [{ page: ranged.page, text }] };
    const retained = {
      ...ranged,
      importance: 'detail' as const,
      semantics: { ...ranged.semantics, conditions: [text] },
    };
    expect(
      independentAssessment(critical, { facts: [retained], unverified: ['statusを拒否'] })
        .importantFactsSatisfied
    ).toBe(true);
    expect(independentAssessment(critical, { facts: [ranged] }).importantFactsSatisfied).toBe(
      false
    );
  });
});
