import { NATIVE_LIMITS } from './native-disclosure-contract';

export interface ZipEntryEnvelope {
  name: string;
  size: number;
  compressed: number;
  crc: number;
}
/** fflate handles decompression. This narrow ZIP32 envelope check rejects unsupported
 * encryption, multi-disk/ZIP64, conflicting directory records, overlaps and symlinks
 * before allocating output. No ZIP data is ever written to the filesystem. */
export function inspectZipEnvelope(bytes: Uint8Array): Map<string, ZipEntryEnvelope> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => {
    throw new Error('NATIVE:ZIPの構造・整合性が未対応または不正です');
  };
  const u16 = (offset: number) =>
    offset >= 0 && offset + 2 <= bytes.length ? view.getUint16(offset, true) : fail();
  const u32 = (offset: number) =>
    offset >= 0 && offset + 4 <= bytes.length ? view.getUint32(offset, true) : fail();
  let end = bytes.length - 22;
  const earliest = Math.max(0, end - 65535);
  while (end >= earliest && (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length))
    end--;
  if (end < earliest || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10))
    return fail();
  const count = u16(end + 10),
    directorySize = u32(end + 12),
    directoryOffset = u32(end + 16);
  if (!count || count > NATIVE_LIMITS.entries || directoryOffset + directorySize !== end)
    return fail();
  const entries = new Map<string, ZipEntryEnvelope>(),
    caseNames = new Set<string>();
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = directoryOffset,
    total = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let i = 0; i < count; i++) {
    if (u32(offset) !== 0x02014b50) return fail();
    const flags = u16(offset + 8),
      method = u16(offset + 10),
      crc = u32(offset + 16),
      compressed = u32(offset + 20),
      size = u32(offset + 24);
    const nameLength = u16(offset + 28),
      extraLength = u16(offset + 30),
      commentLength = u16(offset + 32),
      local = u32(offset + 42);
    const attributes = u32(offset + 38),
      mode = (attributes >>> 16) & 0xf000;
    // Only UTF-8, data descriptor and deflate-level flags. Strong/traditional encryption rejected.
    if (
      flags & ~0x080e ||
      ![0, 8].includes(method) ||
      u16(offset + 34) ||
      mode === 0xa000 ||
      size > NATIVE_LIMITS.entryBytes ||
      (total += size) > NATIVE_LIMITS.totalBytes ||
      offset + 46 + nameLength + extraLength + commentLength > end ||
      local >= directoryOffset
    )
      return fail();
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    if (caseNames.has(name.toLowerCase())) return fail();
    caseNames.add(name.toLowerCase());
    if (
      u32(local) !== 0x04034b50 ||
      u16(local + 6) !== flags ||
      u16(local + 8) !== method ||
      u16(local + 26) !== nameLength
    )
      return fail();
    const localExtra = u16(local + 28),
      dataStart = local + 30 + nameLength + localExtra;
    if (
      decoder.decode(bytes.subarray(local + 30, local + 30 + nameLength)) !== name ||
      dataStart + compressed > directoryOffset
    )
      return fail();
    let dataEnd = dataStart + compressed;
    if (flags & 8) {
      if (
        ![0, crc].includes(u32(local + 14)) ||
        ![0, compressed].includes(u32(local + 18)) ||
        ![0, size].includes(u32(local + 22))
      )
        return fail();
      const descriptor = dataEnd + (u32(dataEnd) === 0x08074b50 ? 4 : 0);
      if (
        u32(descriptor) !== crc ||
        u32(descriptor + 4) !== compressed ||
        u32(descriptor + 8) !== size
      )
        return fail();
      dataEnd = descriptor + 12;
    } else if (
      u32(local + 14) !== crc ||
      u32(local + 18) !== compressed ||
      u32(local + 22) !== size
    )
      return fail();
    if (dataEnd > directoryOffset) return fail();
    ranges.push({ start: local, end: dataEnd });
    entries.set(name, { name, size, compressed, crc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (offset !== end) return fail();
  ranges.sort((a, b) => a.start - b.start);
  if (
    ranges[0].start !== 0 ||
    ranges[ranges.length - 1].end !== directoryOffset ||
    ranges.some((range, index) => index > 0 && ranges[index - 1].end !== range.start)
  )
    return fail();
  return entries;
}
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let n = i;
  for (let j = 0; j < 8; j++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
  crcTable[i] = n >>> 0;
}
export function updateCrc32(crc: number, bytes: Uint8Array): number {
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
