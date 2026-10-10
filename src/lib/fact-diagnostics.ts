/** New diagnostic entries use the candidate contract's existing UTF-16 limit. */
export const FACT_DIAGNOSTIC_CHUNK_LENGTH = 1000;

/**
 * Saved v6 results can contain longer code-generated diagnostics. Readers must
 * preserve them exactly: changing a reason also changes the result/review hash.
 * Length is a production chunk size, never a reason to invalidate an old cache.
 * Diagnostics are not financial facts and cannot bypass source verification.
 */
export function isFactDiagnostics(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  // Unlike Array.every, iteration also rejects holes in an in-memory array.
  for (const reason of value) if (typeof reason !== 'string') return false;
  return true;
}

/** Lossless, bounded entries for new diagnostics; never deduplicate chunks. */
export function chunkFactDiagnostics(reasons: string[]): string[] {
  if (!isFactDiagnostics(reasons)) throw new Error('未確認理由は文字列の配列が必要です');
  return reasons.flatMap((reason) => {
    if (reason.length <= FACT_DIAGNOSTIC_CHUNK_LENGTH) return [reason];
    const chunks: string[] = [];
    for (let start = 0; start < reason.length; ) {
      let end = Math.min(start + FACT_DIAGNOSTIC_CHUNK_LENGTH, reason.length);
      // Do not split a Unicode surrogate pair across display entries.
      if (
        end < reason.length &&
        reason.charCodeAt(end - 1) >= 0xd800 &&
        reason.charCodeAt(end - 1) <= 0xdbff &&
        reason.charCodeAt(end) >= 0xdc00 &&
        reason.charCodeAt(end) <= 0xdfff
      )
        end--;
      chunks.push(reason.slice(start, end));
      start = end;
    }
    return chunks;
  });
}
