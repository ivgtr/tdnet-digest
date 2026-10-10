import { canonicalJSON } from './fact-contract';
import { validateSourceLedger, type SourceLedger } from './source-ledger';

/** Compare the extracted source, not the earlier summary's page-selection policy.
 * Stored ledgers still validate their complete checksums (including selection).
 * All physical content, extraction status and derived markers remain compared.
 */
export function sameSourceLedgerContent(a: SourceLedger, b: SourceLedger): boolean {
  const content = (ledger: SourceLedger) => {
    const checked = validateSourceLedger(ledger);
    return {
      version: checked.version,
      rows: checked.rows,
      pages: checked.pages.map(({ selection: _selection, ...page }) => page),
    };
  };
  return canonicalJSON(content(a)) === canonicalJSON(content(b));
}
