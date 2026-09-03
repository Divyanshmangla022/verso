import { inflateRawSync } from 'node:zlib';
import { badRequest } from '../http/errors.ts';

/**
 * Zip-bomb guard for .docx uploads. A .docx is a ZIP; mammoth fully inflates
 * it in memory, so a small upload with an extreme compression ratio could
 * exhaust the process.
 *
 * Two passes, cheapest first:
 *  1. Read the ZIP central directory (no decompression) and reject archives
 *     whose *declared* inflated size or entry count is already over budget.
 *  2. Verify those declarations, because they are attacker-controlled: inflate
 *     each entry with a hard output cap of its declared size. zlib aborts the
 *     moment the real stream exceeds that, so a header claiming 1 KB can never
 *     spend more than 1 KB of memory no matter what the deflate stream holds.
 *
 * Without pass 2 the guard is decorative: mammoth reads entries through JSZip,
 * which only compares the inflated length against the declared one *after*
 * inflating the whole entry into memory.
 */
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB total inflated
const MAX_ENTRIES = 2_000;

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;

const STORED = 0;
const DEFLATED = 8;

interface CentralDirectoryEntry {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export function assertZipWithinLimits(buffer: Buffer): void {
  const entries = readCentralDirectory(buffer);
  let declaredTotal = 0;
  for (const entry of entries) {
    declaredTotal += entry.uncompressedSize;
    if (declaredTotal > MAX_UNCOMPRESSED_BYTES) {
      throw badRequest('This .docx would expand beyond the import size limit');
    }
  }
  for (const entry of entries) {
    verifyEntry(buffer, entry);
  }
}

function readCentralDirectory(buffer: Buffer): CentralDirectoryEntry[] {
  // Locate the end-of-central-directory record (scan back past an optional comment).
  const scanFrom = Math.max(0, buffer.length - 22 - 65_535);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw badRequest('This file is not a valid .docx (ZIP archive)');

  const entryCount = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (cdOffset === ZIP64_MARKER) {
    throw badRequest('ZIP64 .docx files are not supported by the importer');
  }
  if (entryCount > MAX_ENTRIES) {
    throw badRequest('This .docx contains too many internal entries to import');
  }

  const entries: CentralDirectoryEntry[] = [];
  let offset = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CDFH_SIG) {
      throw badRequest('This file is not a valid .docx (corrupt archive index)');
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    if (compressedSize === ZIP64_MARKER || uncompressedSize === ZIP64_MARKER || localHeaderOffset === ZIP64_MARKER) {
      throw badRequest('ZIP64 .docx files are not supported by the importer');
    }
    entries.push({ method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * Inflate one entry with its declared size as a hard ceiling. A truthful entry
 * inflates to exactly that size; a lying one blows the cap and is rejected
 * without ever materialising the payload.
 */
function verifyEntry(buffer: Buffer, entry: CentralDirectoryEntry): void {
  if (entry.uncompressedSize === 0 && entry.compressedSize === 0) return; // directory entry
  if (entry.method !== STORED && entry.method !== DEFLATED) {
    throw badRequest('This .docx uses an unsupported compression method');
  }

  const header = entry.localHeaderOffset;
  if (header + 30 > buffer.length || buffer.readUInt32LE(header) !== LFH_SIG) {
    throw badRequest('This file is not a valid .docx (corrupt entry header)');
  }
  const nameLen = buffer.readUInt16LE(header + 26);
  const extraLen = buffer.readUInt16LE(header + 28);
  const start = header + 30 + nameLen + extraLen;
  const end = start + entry.compressedSize;
  if (end > buffer.length) {
    throw badRequest('This file is not a valid .docx (truncated entry)');
  }

  if (entry.method === STORED) {
    // Stored entries cannot expand, but the declaration still has to be honest.
    if (entry.compressedSize !== entry.uncompressedSize) {
      throw badRequest('This .docx declares an inconsistent entry size');
    }
    return;
  }

  let inflated: Buffer;
  try {
    inflated = inflateRawSync(buffer.subarray(start, end), {
      // +1 so an entry that is even one byte larger than declared still trips.
      maxOutputLength: entry.uncompressedSize + 1,
    });
  } catch {
    // RangeError (over the cap) or a corrupt stream - both are rejections here.
    throw badRequest('This .docx would expand beyond the import size limit');
  }
  if (inflated.length !== entry.uncompressedSize) {
    throw badRequest('This .docx declares an inconsistent entry size');
  }
}
