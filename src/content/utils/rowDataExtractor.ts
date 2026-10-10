/** TDnetテーブル行から、実際に掲載されたリンクだけを取得する。 */
import {
  validateNativeCompanionRef,
  type NativeCompanionRef,
} from '../../lib/native-disclosure-contract';
import { normalizeTdnetPdfUrl } from '../../lib/tdnet-url';

export interface RowData {
  time: string;
  code: string;
  companyName: string;
  title: string;
  pdfUrl: string;
  nativeCompanion?: NativeCompanionRef;
}

export function extractRowData(row: Element): RowData | null {
  const timeCell = row.querySelector('.kjTime');
  const codeCell = row.querySelector('.kjCode');
  const nameCell = row.querySelector('.kjName');
  const titleCell = row.querySelector('.kjTitle');
  const linkElement = titleCell?.querySelector('a');
  if (!timeCell || !codeCell || !nameCell || !titleCell || !linkElement) return null;
  const data: RowData = {
    time: timeCell.textContent?.trim() || '',
    code: codeCell.textContent?.trim() || '',
    companyName: nameCell.textContent?.trim() || '',
    title: linkElement.textContent?.trim() || '',
    pdfUrl: linkElement.getAttribute('href') || '',
  };
  // No archive lookup, date-index crawl, filename substitution, or cross-row search.
  const nativeLinks = row.querySelectorAll('.kjXbrl a[href]');
  if (nativeLinks.length !== 1) return data;
  try {
    const listingUrl = row.ownerDocument.URL;
    const date = new URL(listingUrl).pathname.match(/I_list_\d{3}_(\d{4})(\d{2})(\d{2})\.html$/);
    const pdfUrl = normalizeTdnetPdfUrl(data.pdfUrl);
    const disclosureId = new URL(pdfUrl).pathname.match(/1401(\d{14})\.pdf$/)?.[1];
    if (!date || !disclosureId) return data;
    data.nativeCompanion = validateNativeCompanionRef({
      kind: 'tdnet-row',
      zipUrl: new URL(nativeLinks[0].getAttribute('href')!, listingUrl).href,
      pdfUrl,
      listingUrl,
      disclosureId,
      publishedDate: `${date[1]}-${date[2]}-${date[3]}`,
      code: data.code,
      title: data.title,
      correction:
        /訂正|修正|correction|corrected/i.test(data.title) ||
        Boolean(row.querySelector('.kjHistroy, .kjHistory')?.textContent?.trim()),
    });
  } catch {
    // An absent or untrusted optional companion leaves the existing PDF path intact.
  }
  return data;
}
