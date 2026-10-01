/** TDnet一覧の相対リンクと絶対リンクを同じ検証済みPDF URLに揃える。 */
export function normalizeTdnetPdfUrl(url: string): string {
  const parsed = new URL(url, 'https://www.release.tdnet.info/inbs/');
  if (
    parsed.origin !== 'https://www.release.tdnet.info' ||
    parsed.username ||
    parsed.password ||
    !parsed.pathname.startsWith('/inbs/') ||
    !/\.pdf$/i.test(parsed.pathname)
  )
    throw new Error('TDnetのPDF URLではありません');
  return parsed.href;
}
