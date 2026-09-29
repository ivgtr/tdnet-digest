export const SCORING_PDF_PERMISSION = 'https://*/*';

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
