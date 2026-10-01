import type { ExtractedPage } from '@/types/summaryMetadata';
import type { ContextBinding } from './document-context';
import { datedStates } from './fact-validation';
/** Date-role proposals stay attached to the exact source/context that establishes them. */
export function sourceDateOptions(binding: ContextBinding, pages: ExtractedPage[]) {
  const refs = [binding.blockId, ...binding.contextIds];
  const options = refs.flatMap((sourceId) => {
    const text =
      pages.flatMap((p) => p.blocks).find((b) => b.id === sourceId)?.text ??
      pages.flatMap((p) => p.spans).find((s) => s.id === sourceId)?.text;
    if (text === undefined) throw new Error(`REFERENCE:日付の適用根拠 ${sourceId} がありません`);
    return datedStates(text).map((d) => ({ ...d, sourceId }));
  });
  return options.filter(
    (d, i) =>
      options.findIndex(
        (other) => other.date === d.date && other.state === d.state && other.sourceId === d.sourceId
      ) === i
  );
}
