import { describe, expect, it } from 'vitest';
import { classifyMetric } from './metric-semantics';
import { textPage, numberCandidate } from './fixtures/v4-test-source';
import { parseFactSummary } from './fact-summary';
import { toValue, validateScoreInput } from './score-extraction';

describe('数量の指標区分と配当の分母', () => {
  it.each([
    ['年間配当金合計', '円', 'perShare'],
    ['年間配当金期末', '円', 'perShare'],
    ['1株当たり配当金', '千円', 'perShare'],
    ['配当金総額', '百万円', 'amount'],
    ['配当金総額', '円', 'amount'],
    ['配当金', '百万円', 'amount'],
    ['配当金支払額', '円', 'amount'],
    ['配当金増減率', '%', 'rate'],
  ])('%s / %s の意味を分類する', (label, unit, kind) =>
    expect(classifyMetric(label, unit)).toBe(kind)
  );

  it.each([
    ['配当金総額', '百万円'],
    ['配当金総額', '円'],
    ['配当金', '百万円'],
  ])(
    '%s / %s の総額を確定できても範囲・基準なしでは採点せず、perShareへの誤分類を拒否する',
    (label, unit) => {
      const pages = ['前回予想', '今回予想'].map((state, index) =>
        textPage(
          `会社名 株式会社テスト\n2026年3月期 ${state}\n${label}は${100 + index * 10}${unit}です。`,
          index + 1
        )
      );
      const candidates = pages.map((page, index) => {
        const fact = numberCandidate(page, label, 100 + index * 10);
        fact.id = `f${index + 1}`;
        fact.unit = unit;
        fact.semantics.scope = fact.semantics.basis = null;
        fact.valueKind = fact.semantics.state = index ? 'forecastAfter' : 'forecastBefore';
        return fact;
      });
      const raw = (facts: unknown[]) =>
        JSON.stringify({ version: 5, documentType: 'other', facts, unverified: [] });
      const facts = parseFactSummary(raw(candidates), 'other', pages);
      expect(facts.unverified).toEqual([]);
      expect(facts.facts).toHaveLength(2);
      const document = {
        url: 'https://www.release.tdnet.info/inbs/test.pdf',
        text: '',
        pages,
        issuer: '株式会社テスト',
        code: '1234',
        publishedDate: null,
      };
      expect(() => toValue(facts.facts[1], document)).toThrow('範囲');
      const input = validateScoreInput(
        JSON.stringify({
          version: 4,
          claims: [
            {
              category: 'shareholderReturn',
              label,
              current: facts.facts[1].id,
              previous: facts.facts[0].id,
              earlier: null,
              relatedValue: null,
              companyExplanation: null,
            },
          ],
          unverified: [],
        }),
        [{ document, facts }],
        '原文'
      );
      expect(input.claims).toHaveLength(0);
      expect(input.unverified.join(' ')).toContain('範囲');
      const wrong = candidates.map((f) => ({
        ...f,
        semantics: { ...f.semantics, metricKind: 'perShare' },
      }));
      expect(parseFactSummary(raw(wrong), 'other', pages, false).facts).toHaveLength(0);
      const forged = structuredClone(facts.facts[1]);
      forged.semantics.metricKind = 'perShare';
      expect(() => toValue(forged, document)).toThrow('範囲');
    }
  );
});
