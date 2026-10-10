import { Unzip, UnzipInflate } from 'fflate';
import { inspectZipEnvelope, updateCrc32 } from './native-disclosure-zip-envelope';
import { NATIVE_LIMITS } from './native-disclosure-contract';

export function safeArchivePath(path: string): string {
  if (
    !path ||
    path.length > 300 ||
    /[\\:%?#]/.test(path) ||
    [...path].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    path.startsWith('/') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('NATIVE:安全でないZIP内パスです');
  return path;
}
/** Streaming output is bounded independently of attacker-controlled ZIP size fields.
 * Nothing is written to disk. Only UTF-8 XML/XHTML is consumed by the inert parser. */
export function readNativeArchive(bytes: Uint8Array): Map<string, string> {
  if (
    bytes.byteLength > NATIVE_LIMITS.archiveBytes ||
    bytes.byteLength < 22 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 3 ||
    bytes[3] !== 4
  )
    throw new Error('NATIVE:ZIP形式または圧縮ファイルサイズが不正です');
  const envelope = inspectZipEnvelope(bytes);
  const files = new Map<string, string>();
  const names = new Set<string>();
  let total = 0,
    opened = 0,
    completed = 0;
  const unzip = new Unzip((entry) => {
    if (++opened > NATIVE_LIMITS.entries) throw new Error('NATIVE:ZIPファイル数の上限を超えました');
    // Directories are harmless but still count, and cannot alias a file name.
    const expected = envelope.get(entry.name);
    if (!expected) throw new Error('NATIVE:ZIPのディレクトリと内容が一致しません');
    const directory = entry.name.endsWith('/');
    const path = safeArchivePath(directory ? entry.name.slice(0, -1) : entry.name);
    const key = path.toLowerCase();
    if (names.has(key)) throw new Error('NATIVE:ZIP内の重複パスは使用できません');
    names.add(key);
    if (entry.originalSize !== undefined && entry.originalSize > NATIVE_LIMITS.entryBytes)
      throw new Error('NATIVE:ZIP展開サイズの上限を超えました');
    const chunks: Uint8Array[] = [];
    let size = 0,
      crc = 0xffffffff;
    entry.ondata = (error, data, final) => {
      if (error) throw error;
      size += data.length;
      total += data.length;
      crc = updateCrc32(crc, data);
      if (size > NATIVE_LIMITS.entryBytes || total > NATIVE_LIMITS.totalBytes) {
        entry.terminate();
        throw new Error('NATIVE:ZIP展開サイズの上限を超えました');
      }
      if (!directory && /\.(?:xml|xhtml|html?|xsd)$/i.test(path)) chunks.push(data);
      if (final) {
        completed++;
        if (
          size !== expected.size ||
          (crc ^ 0xffffffff) >>> 0 !== expected.crc ||
          (entry.originalSize !== undefined && size !== entry.originalSize)
        )
          throw new Error('NATIVE:ZIPサイズ情報が一致しません');
        if (chunks.length) {
          const content = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            content.set(chunk, offset);
            offset += chunk.length;
          }
          files.set(path, new TextDecoder('utf-8', { fatal: true }).decode(content));
        }
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);
  // Small compressed chunks constrain transient inflate output before budget checks run.
  for (let offset = 0; offset < bytes.length; offset += 1024)
    unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  if (!opened || opened !== completed || opened !== envelope.size || !files.size)
    throw new Error('NATIVE:ZIPが不完全か対応文書がありません');
  return files;
}
