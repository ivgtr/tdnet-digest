import { describe, expect, it } from 'vitest';
import { getFormatPrompt } from './format-prompts';
import { getExtractionPrompt, getPromptForDocumentType } from './prompts';
import { getJsonSchema } from './summary-schema';

const context = {
  period: 'q2' as const,
  accountingStandard: 'jpGaap' as const,
  isConsolidated: true,
};

describe('決算分析プロンプト', () => {
  it('1パスでも利益の質と時間軸別診断を要求する', () => {
    const { system } = getPromptForDocumentType('earnings', '[PDF_PAGE:1]\n売上高', context);
    expect(system).toContain('## 利益の質');
    expect(system).toContain('## 時間軸別の見方');
    expect(system).toContain('据え置きだけを理由に大幅なマイナス評価をしない');
    expect(system).toContain('市場コンセンサス');
  });

  it('パス1で根拠ページと空配列を要求する', () => {
    const { system } = getExtractionPrompt('earnings', '[PDF_PAGE:1]\n売上高', context);
    expect(system).toContain('[PDF_PAGE:N]');
    expect(system).toContain('好材料・リスクに根拠がない場合は空配列');
    expect(system).toContain('earningsQuality');
    expect(system).toContain('investmentView');
  });

  it('決算JSONスキーマに利益品質と投資診断を含める', () => {
    const schema = getJsonSchema('earnings', context);
    expect(schema).toContain('"earningsQuality"');
    expect(schema).toContain('"investmentView"');
    expect(schema).toContain('"watchPoints"');
  });

  it('パス2で方向性と根拠ページを表示する', () => {
    const { system } = getFormatPrompt('earnings', {}, context);
    expect(system).toContain('positive=強気');
    expect(system).toContain('[p.{page}]');
    expect(system).toContain('## 評価理由');
  });
});
