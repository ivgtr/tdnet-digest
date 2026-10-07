import { getProvider } from './llm-providers';

/** The URL that fetch sends: keep path/query semantics, discard only the fragment. */
export function effectiveApiUrl(config: { provider: string; baseUrl?: string }): string {
  const raw = config.baseUrl || getProvider(config.provider)?.baseUrl;
  let url: URL;
  try {
    url = new URL(raw ?? '');
  } catch {
    // Never echo a URL: query parameters may contain credentials.
    throw new Error('API URLが不正です');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
    throw new Error('API URLが不正です。URLに認証情報を含めないでください');
  url.hash = '';
  return url.href;
}

/** Preserve stored URL overrides for every provider, including imported settings. */
export function configuredApiUrl(settings: { provider: string; customUrl?: string }): string {
  return effectiveApiUrl({
    provider: settings.provider,
    baseUrl: settings.customUrl,
  });
}
