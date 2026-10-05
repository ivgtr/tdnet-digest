import { dividendPaymentExcerpt, explanationRole } from './summary-content-policy';
import type { SourceExcerpt } from './summary-source-inventory';

const compact = (text: string) => text.normalize('NFKC').replace(/\s/g, '');
// These qualifications can apply across sentences. Do not detach them from their claim.
const qualification =
  /ただし|但し|しかし|一方|ものの|ではなく|ではありません|を除|に限|承認|条件|可能性|未定|不確実|速報|予定|上限|下限|概算|合理的に.*(?:見積|算定)/;
const lead = /^(?:以上の結果、|なお、|したがって、|加えて、|この結果、|また、)/;

/** Literal reading excerpts only; the complete source remains in its closed source group.
 * Select sentences or explicit causal clauses, never a character-count prefix or a paraphrase. */
export function companyExcerpt(
  source: Pick<SourceExcerpt, 'text' | 'role'>,
  options: { comparisons?: boolean } = {}
): string | null {
  const text = source.text.replace(/\s+/g, ' ').trim();
  const normalized = compact(text);
  const payment = dividendPaymentExcerpt(text);
  if (/上場会社名.*代表者/.test(normalized)) return payment;
  if (source.role === 'document' || source.role === 'unclassified') return null;
  if (payment) return payment;

  const sentences = text.match(/[^。]+(?:。|$)/g) ?? [];
  if (!sentences.length) return null;
  if (qualification.test(normalized) || /場合/.test(normalized.replace(/通常の場合/g, '')))
    return text;

  // General economic introductions and bridges do not explain this company's result.
  if (
    source.role === 'performance' &&
    ((/^(?:当[^。]*期間における)?(?:わが国|我が国|世界|国内|日本)経済/.test(normalized) &&
      !/当社|当グループ|売上高|営業利益/.test(normalized)) ||
      (/^このような.*(?:環境|状況).*中、(?:当社|当グループ)/.test(normalized) &&
        !/[0-9]|条件|可能性|未定/.test(normalized)))
  )
    return null;

  if (source.role === 'finance' && /^(?:収入|支出)の(?:主な)?内訳/.test(normalized)) return null;
  const seasonal = sentences.filter((sentence) => /季節|偏る/.test(compact(sentence)));
  // An explicit statement of seasonality stands alone; its tendency/limitation stays intact.
  if (seasonal.length)
    return seasonal.map((sentence) => sentence.trim().replace(lead, '')).join(' ');
  if (/場合/.test(normalized)) return text;

  const causes = sentences.flatMap((sentence) => {
    const result = sentence.match(
      /(?:こと)?(?:など)?(?:により|によって|から)、\s*(?:売上高|売上収益|営業収益|営業利益|経常利益|(?:当期|中間|四半期)純利益)\s*は/
    );
    if (!result || result.index === undefined) return [];
    // Remove reporting context, keeping the company's literal causal clause.
    const cause = sentence
      .slice(0, result.index)
      .trim()
      .replace(lead, '')
      .replace(/^(?:当[^、。]*業績は、|利益につきましては、)/, '');
    if (!cause) return [];
    // Preserve the source's comparison/rate without repeating its reported amounts.
    // Ellipses mark omitted text; these fragments remain quotations, not verified rate facts.
    const comparisons =
      options.comparisons === false
        ? []
        : [
            ...sentence.matchAll(
              /(売上高|売上収益|営業収益|営業利益|経常利益|(?:当期|中間|四半期)純利益)\s*は[^、。]*?(前[^、。]*?(?:と|に)\s*比\s*べ)[^、。]*?([（(][^）)]*[%％][）)]の(?:減収|増収|減益|増益))/g
            ),
          ].map((match) => `${match[1]}…${match[2]}…${match[3]}`);
    return [cause, ...comparisons];
  });
  if (causes.length) return causes.join('／');

  // For balance/cash-flow explanations, show the reported movement; its detailed breakdown
  // remains available in the source. Reasons and conditions have priority in other topics.
  if (source.role === 'finance') return sentences[0]!.trim().replace(lead, '');
  const reasons = sentences.filter(
    (sentence) =>
      explanationRole(sentence) !== null ||
      (['performance', 'operations'].includes(source.role) &&
        /開始|稼働|出店|閉鎖|変更|改定|計上|取得|契約/.test(sentence))
  );
  if (reasons.length)
    return reasons
      .map((sentence) => {
        const excerpt = sentence.trim().replace(lead, '');
        // Operational reading: keep the stated subject and action/date. The history and
        // purpose are still complete in the source. Purpose/reason topics are not shortened here.
        const action = ['performance', 'operations'].includes(source.role)
          ? excerpt.match(/^([^、。]+は、)[^。]+を目的として、(.+)$/)
          : null;
        return action ? `${action[1]}…${action[2]}` : excerpt;
      })
      .join(' ');
  return sentences[0]!.trim().replace(lead, '');
}
