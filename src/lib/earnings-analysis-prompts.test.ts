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
    expect(system).toContain('"previousAmount"');
    expect(system).toContain('"businessPl"');
    expect(system).toContain('増減率が「－」でも、比較金額は省略しない');
    expect(system).toContain('最も精密な金額');
    expect(system).toContain('businessPl.items');
  });

  it('会計基準別の評価指標と一時損益の境界を明示する', () => {
    const ifrsContext = { ...context, accountingStandard: 'ifrs' as const };
    const { system } = getExtractionPrompt('earnings', '[PDF_PAGE:1]\n税引前利益', ifrsContext);
    expect(system).toContain('IFRS・米国基準では税引前利益');
    expect(system).toContain('税引前利益について');
    expect(system).toContain('損失消化率');
    expect(system).toContain('M&A、合併、事業施策の説明だけを入れない');
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
    expect(system).toContain('## 事業P/L');
  });

  it('IFRSのパス2では税引前利益の表示名を使う', () => {
    const ifrsContext = { ...context, accountingStandard: 'ifrs' as const };
    const { system } = getFormatPrompt('earnings', {}, ifrsContext);
    expect(system).toContain('## 決算評価（税引前利益ベース）');
    expect(system).toContain('税引前利益の損失消化率');
    expect(system).toContain('lastYearProgressがnullでない場合のみ');
    expect(system).not.toContain('## 決算評価（経常利益ベース）');
  });
});
