import { describe, expect, it } from 'vitest';
import type { DocumentType } from './document-type';
import { getFormatPrompt } from './format-prompts';
import { getExtractionPrompt, getPromptForDocumentType } from './prompts';
import { getJsonSchema } from './summary-schema';

const cases: Array<{
  type: DocumentType;
  promptText: string;
  schemaField: string;
  templateText: string;
}> = [
  {
    type: 'shareholderBenefit',
    promptText: '継続保有条件',
    schemaField: 'eligibleShareholders',
    templateText: '## 優待変更',
  },
  {
    type: 'stockSplit',
    promptText: '株式分割それ自体は企業価値や株主価値を創出するものと断定しない',
    schemaField: 'authorizedSharesChange',
    templateText: '## 分割・併合内容',
  },
  {
    type: 'capitalPolicy',
    promptText: '希薄化率',
    schemaField: 'useOfFunds',
    templateText: '## 資金使途',
  },
  {
    type: 'businessUpdate',
    promptText: '通期業績を外挿・断定しない',
    schemaField: 'oneOffFactors',
    templateText: '## 主要KPI',
  },
  {
    type: 'governance',
    promptText: '内部統制・再発防止策',
    schemaField: 'governanceChanges',
    templateText: '## 内部統制・再発防止',
  },
];

describe.each(cases)('$type 専用分析', ({ type, promptText, schemaField, templateText }) => {
  it('1パスプロンプトを専用化する', () => {
    const { system } = getPromptForDocumentType(type, '[PDF_PAGE:1]\n本文');
    expect(system).toContain(promptText);
    expect(system).toContain('## 時間軸別の見方');
  });

  it('パス1スキーマと抽出制約を専用化する', () => {
    const schema = getJsonSchema(type);
    const { system } = getExtractionPrompt(type, '[PDF_PAGE:1]\n本文');
    expect(schema).toContain(`"${schemaField}"`);
    expect(schema).toContain('"investmentView"');
    expect(system).toContain('短期は開示直後〜数週間');
  });

  it('パス2テンプレートを専用化する', () => {
    const { system } = getFormatPrompt(type, {});
    expect(system).toContain(templateText);
    expect(system).toContain('## 評価理由');
  });
});

describe('既存の非決算系分析', () => {
  it.each<DocumentType>(['earningsRevision', 'dividend', 'shareRepurchase', 'ma'])(
    '%s に時間軸別評価を含める',
    (type) => {
      expect(getJsonSchema(type)).toContain('"investmentView"');
      expect(getPromptForDocumentType(type, '本文').system).toContain('## 時間軸別の見方');
      expect(getFormatPrompt(type, {}).system).toContain('## 時間軸別の見方');
    }
  );
});
