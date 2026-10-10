// @vitest-environment jsdom
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { parseNativeDisclosureArchive } from './native-disclosure';
import {
  nativeFixtureFiles,
  nativeFixtureRef,
  nativeFixturePdfText,
} from './fixtures/native-disclosure-source';
import { nativeAnalysisCalculations, nativeAnalysisEvidence } from './native-analysis';
import type { NativeDisclosure } from './native-disclosure-contract';

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
});
afterAll(() => vi.unstubAllGlobals());
async function fixture(which: 'cando' | 'yaskawa' = 'cando') {
  return parseNativeDisclosureArchive(
    zipSync(
      Object.fromEntries(
        Object.entries(nativeFixtureFiles(which)).map(([path, text]) => [path, strToU8(text)])
      )
    ),
    nativeFixtureRef(which),
    { pdfText: nativeFixturePdfText(which) }
  );
}
const calculation = (n: NativeDisclosure, concept: string, label: string) =>
  nativeAnalysisCalculations(n).find((e) => e.text.startsWith(`tse:${concept} ${label}:`));
describe('native source-bound arithmetic', () => {
  it('computes checked public amount examples and withholds non-additive EPS residuals', async () => {
    const n = await fixture();
    expect(calculation(n, 'OperatingIncome', '前年同期間差')?.text).toContain('= -327000000');
    expect(calculation(n, 'OperatingIncome', '残期間に必要な水準')?.text).toContain('= 673000000');
    expect(
      calculation(n, 'ProfitAttributableToOwnersOfParent', '残期間に必要な水準')?.text
    ).toContain('= -30000000');
    expect(calculation(n, 'NetIncomePerShare', '残期間に必要な水準')).toBeUndefined();
    expect(nativeAnalysisEvidence(n).some((e) => e.text.includes('UnknownPublicMetric'))).toBe(
      true
    );
    const y = await fixture('yaskawa');
    expect(calculation(y, 'ProfitBeforeTaxIFRS', '前年同期間差')?.text).toContain('= 759000000');
    expect(calculation(y, 'ProfitBeforeTaxIFRS', '残期間に必要な水準')?.text).toContain(
      '= 39537000000'
    );
  });
  it.each(['unit', 'entity', 'period', 'scope', 'nil', 'duplicate', 'unknown-additivity'] as const)(
    'withholds only incompatible %s operands and retains source',
    async (change) => {
      const n = await fixture();
      const current = n.facts.find(
        (f) => f.concept.localName === 'OperatingIncome' && f.literal === '997'
      )!;
      const c = n.contexts.find((c) => c.id === current.contextId)!;
      if (change === 'unit') current.unitId = n.units.find((u) => u.denominator.length)!.id;
      if (change === 'entity') c.entity.identifier = '別会社';
      if (change === 'period') c.period.start = '2026-04-01';
      if (change === 'scope') c.consolidation = 'nonconsolidated';
      if (change === 'nil') {
        current.status = 'nil';
        current.value = null;
      }
      if (change === 'duplicate') n.facts.push({ ...current, id: 'other-identical-cell' });
      if (change === 'unknown-additivity')
        for (const f of n.facts.filter((f) => f.concept.localName === 'OperatingIncome'))
          f.concept = {
            qname: 'ext:AverageAmount',
            namespace: 'urn:unknown',
            localName: 'AverageAmount',
          };
      expect(calculation(n, 'OperatingIncome', '残期間に必要な水準')).toBeUndefined();
      expect(
        nativeAnalysisCalculations(n).some((e) => e.text.includes('AverageAmount 残期間'))
      ).toBe(false);
      expect(nativeAnalysisEvidence(n).some((e) => e.sourceIds.includes(current.id))).toBe(true);
    }
  );
});
