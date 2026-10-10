import type { CachedSummary } from '@/types/summaryMetadata';

const ENCODING = 'tdnet-summary-gzip-v1';
const COMPRESS_AFTER_BYTES = 256 * 1024;
const MAX_DECODED_BYTES = 32 * 1024 * 1024;
interface CompressedSummary {
  encoding: typeof ENCODING;
  payload: string;
  decodedBytes: number;
  companyName: string;
  title: string;
  code: string;
  cachedAt: number;
  resultId: string;
}

function isCompressed(value: unknown): value is CompressedSummary {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as Partial<CompressedSummary>).encoding === ENCODING
  );
}

async function collect(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error('保存された要約の展開サイズが上限を超えています');
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function byteStream(bytes: Uint8Array<ArrayBuffer>): ReadableStream<BufferSource> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/** Lossless transport only. Every restored entry still undergoes ordinary source validation. */
export async function encodeSummaryStorage(
  entry: CachedSummary
): Promise<CachedSummary | CompressedSummary> {
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  if (
    bytes.byteLength < COMPRESS_AFTER_BYTES ||
    bytes.byteLength > MAX_DECODED_BYTES ||
    typeof CompressionStream === 'undefined'
  )
    return entry;
  const compressed = await collect(
    byteStream(bytes).pipeThrough(new CompressionStream('gzip')),
    MAX_DECODED_BYTES
  );
  let binary = '';
  for (let offset = 0; offset < compressed.length; offset += 8192)
    binary += String.fromCharCode(...compressed.subarray(offset, offset + 8192));
  const encoded: CompressedSummary = {
    encoding: ENCODING,
    payload: btoa(binary),
    decodedBytes: bytes.byteLength,
    companyName: entry.companyName,
    title: entry.title,
    code: entry.code,
    cachedAt: entry.cachedAt,
    resultId: entry.resultId,
  };
  return JSON.stringify(encoded).length < bytes.byteLength ? encoded : entry;
}

export async function decodeSummaryStorage(value: unknown): Promise<unknown> {
  if (!isCompressed(value)) return value;
  if (
    typeof value.payload !== 'string' ||
    value.payload.length > MAX_DECODED_BYTES ||
    !Number.isSafeInteger(value.decodedBytes) ||
    value.decodedBytes < 0 ||
    value.decodedBytes > MAX_DECODED_BYTES
  )
    throw new Error('保存された圧縮要約の形式が不正です');
  const binary = atob(value.payload);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const decoded = await collect(
    byteStream(bytes).pipeThrough(new DecompressionStream('gzip')),
    value.decodedBytes
  );
  if (decoded.byteLength !== value.decodedBytes)
    throw new Error('保存された圧縮要約のサイズが一致しません');
  const entry = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  if (
    !entry ||
    typeof entry !== 'object' ||
    ['resultId', 'companyName', 'title', 'code', 'cachedAt'].some(
      (key) => entry[key] !== value[key as keyof CompressedSummary]
    )
  )
    throw new Error('保存された圧縮要約の識別情報が一致しません');
  return entry;
}

export function isSummaryStorageEntry(value: unknown): boolean {
  return !!value && typeof value === 'object' && ('facts' in value || isCompressed(value));
}

export function summaryStorageWarning(error: unknown, subject = '要約'): string {
  const message = error instanceof Error ? error.message : String(error);
  const reason = /quota|QUOTA_BYTES|容量|上限/i.test(message)
    ? '保存容量が不足しています。設定の「要約キャッシュ管理」で不要な要約を削除してから再度お試しください。'
    : 'ブラウザーの保存処理に失敗しました。拡張機能が有効か確認してください。';
  return `${subject}を保存できませんでした。${reason}表示結果は利用できますが、ページを再読み込みすると失われる場合があります`;
}
