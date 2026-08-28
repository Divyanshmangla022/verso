import { badRequest } from '../http/errors.ts';

/**
 * Zip-bomb guard for .docx uploads. A .docx is a ZIP; mammoth fully inflates
 * it in memory, so a small upload with an extreme compression ratio could
 * exhaust the process. Before handing the buffer to mammoth we read the ZIP
 * end-of-central-directory record and sum the declared uncompressed sizes —
 * no decompression involved.
 */
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024; // 50 MB total inflated
const MAX_ENTRIES = 2_000;

const EOCD_SIG = 0x06054b50;
const CDFH_SIG = 0x02014b50;

export function assertZipWithinLimits(buffer: Buffer): void {
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
  if (entryCount > MAX_ENTRIES) {
    throw badRequest('This .docx contains too many internal entries to import');
  }

  // Walk the central directory headers, summing declared uncompressed sizes.
  let offset = cdOffset;
  let total = 0;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CDFH_SIG) {
      throw badRequest('This file is not a valid .docx (corrupt archive index)');
    }
    total += buffer.readUInt32LE(offset + 24); // uncompressed size
    if (total > MAX_UNCOMPRESSED_BYTES) {
      throw badRequest('This .docx would expand beyond the import size limit');
    }
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    offset += 46 + nameLen + extraLen + commentLen;
  }
}
