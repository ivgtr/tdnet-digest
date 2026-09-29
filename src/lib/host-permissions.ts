export const SCORING_PDF_PERMISSIONS = [
  'https://www2.jpx.co.jp/*',
  'https://ssl4.eir-parts.net/*',
  'https://pdf.irpocket.com/*',
];

export function customApiPermission(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('カスタムAPI URLはHTTPSの完全なURLを指定してください');
  }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
    throw new Error('カスタムAPI URLはHTTPSで指定し、認証情報を含めないでください');
  }
  return `https://${url.hostname}/*`;
}
