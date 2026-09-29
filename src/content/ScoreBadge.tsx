import type { ExperimentalScore } from '@/lib/scoring';

export function ScoreBadge({ score }: { score: ExperimentalScore }) {
  return (
    <div
      style={{
        fontSize: '11px',
        lineHeight: 1.2,
        color: '#1f2937',
        whiteSpace: 'normal',
        textAlign: 'left',
        padding: '2px 0',
      }}
    >
      <strong>
        {score.value === null ? '—' : `${score.value}/100`}・{score.verdict}
      </strong>
      <div>{[...score.positives, ...score.negatives].join(' / ') || '判定理由なし'}</div>
      {score.unverified.length > 0 && <div>未確認あり</div>}
    </div>
  );
}
