import type { DocumentType } from './document-type';
import type { ExtractionResult, InvestmentStance, InvestmentView } from './summary-schema';

export interface ExperimentalScore {
  shortTerm: number | null;
  mediumTerm: number | null;
  longTerm: number | null;
  overall: number | null;
  verdict: string;
  reason: string;
  evidencePages: number[];
}

const STANCE_SCORE: Record<InvestmentStance, number | null> = {
  positive: 80,
  slightlyPositive: 65,
  neutral: 50,
  slightlyNegative: 35,
  negative: 20,
  unknown: null,
};

const WEIGHTS: Record<DocumentType, [number, number, number]> = {
  earnings: [0.4, 0.4, 0.2],
  earningsRevision: [0.5, 0.35, 0.15],
  shareholderBenefit: [0.45, 0.35, 0.2],
  dividend: [0.3, 0.4, 0.3],
  shareRepurchase: [0.4, 0.35, 0.25],
  stockSplit: [0.5, 0.3, 0.2],
  capitalPolicy: [0.25, 0.4, 0.35],
  ma: [0.25, 0.4, 0.35],
  businessUpdate: [0.5, 0.35, 0.15],
  governance: [0.2, 0.35, 0.45],
  other: [0, 0, 0],
};

export function calculateExperimentalScore(
  documentType: DocumentType,
  extraction: ExtractionResult
): ExperimentalScore | null {
  const investmentView = getInvestmentView(extraction);
  if (!investmentView || documentType === 'other') return null;

  const scores: [number | null, number | null, number | null] = [
    STANCE_SCORE[investmentView.shortTerm.stance],
    STANCE_SCORE[investmentView.mediumTerm.stance],
    STANCE_SCORE[investmentView.longTerm.stance],
  ];
  const overall = weightedScore(scores, WEIGHTS[documentType]);

  return {
    shortTerm: scores[0],
    mediumTerm: scores[1],
    longTerm: scores[2],
    overall,
    verdict: scoreVerdict(overall),
    reason: investmentView.rationale,
    evidencePages: collectEvidencePages(investmentView),
  };
}

export function formatExperimentalScore(score: ExperimentalScore): string {
  const display = (value: number | null) => (value === null ? '算出不能' : `${value}/100`);
  const evidence =
    score.evidencePages.length > 0 ? `\n- 根拠ページ: [p.${score.evidencePages.join(', p.')}]` : '';
  return `

## 実験的スコア（参考）
- 短期: ${display(score.shortTerm)}
- 中期: ${display(score.mediumTerm)}
- 長期: ${display(score.longTerm)}
- 総合: ${display(score.overall)}（${score.verdict}）
- 根拠: ${score.reason}${evidence}
- 注意: PDF内の方向性を固定換算した試験値であり、株価・コンセンサス・バリュエーションは含みません。`;
}

function collectEvidencePages(investmentView: InvestmentView): number[] {
  const pages = [
    ...investmentView.shortTerm.rationale,
    ...investmentView.mediumTerm.rationale,
    ...investmentView.longTerm.rationale,
  ]
    .map((fact) => fact.page)
    .filter((page): page is number => page !== null);
  return [...new Set(pages)].sort((a, b) => a - b);
}

function getInvestmentView(extraction: ExtractionResult): InvestmentView | null {
  if (!('investmentView' in extraction)) return null;
  return extraction.investmentView;
}

function weightedScore(
  scores: [number | null, number | null, number | null],
  weights: [number, number, number]
): number | null {
  let weightedTotal = 0;
  let activeWeight = 0;
  scores.forEach((score, index) => {
    if (score === null) return;
    weightedTotal += score * weights[index];
    activeWeight += weights[index];
  });
  return activeWeight === 0 ? null : Math.round(weightedTotal / activeWeight);
}

function scoreVerdict(score: number | null): string {
  if (score === null) return '判断不能';
  if (score >= 70) return '強気';
  if (score >= 58) return 'やや強気';
  if (score >= 43) return '中立';
  if (score >= 30) return 'やや弱気';
  return '弱気';
}
