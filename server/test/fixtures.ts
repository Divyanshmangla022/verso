/**
 * Binary fixtures built in memory, so the repository carries no opaque blobs and
 * every byte of a test input is visible in the source that produces it.
 */
import { once } from 'node:events';
import { createDeflateRaw, crc32, deflateRawSync } from 'node:zlib';

const STORED = 0;
const DEFLATED = 8;

export interface CompressedPayload {
  compressed: Buffer;
  crc: number;
  uncompressedSize: number;
}

export interface ZipEntry {
  name: string;
  data?: Buffer;
  /** An already-deflated payload, for entries too large to hold in memory. */
  raw?: CompressedPayload;
  /** Store the entry uncompressed (default is deflate). */
  stored?: boolean;
  /**
   * Uncompressed size to write into the central directory instead of the real
   * one - i.e. a deliberately dishonest header, which is how a zip bomb hides.
   */
  lieAboutSize?: number;
}

/**
 * Deflate `totalBytes` of a single repeated byte without ever holding them all:
 * the compressed result is a few kilobytes, so a test can describe a payload far
 * larger than the memory it is allowed to use.
 */
export async function deflateRepeated(fill: number, totalBytes: number, chunkBytes = 1024 * 1024): Promise<CompressedPayload> {
  const chunk = Buffer.alloc(chunkBytes, fill);
  const deflate = createDeflateRaw();
  const parts: Buffer[] = [];
  deflate.on('data', (part: Buffer) => parts.push(part));
  const finished = once(deflate, 'end');

  let written = 0;
  let checksum = 0;
  while (written < totalBytes) {
    const size = Math.min(chunkBytes, totalBytes - written);
    const piece = size === chunkBytes ? chunk : chunk.subarray(0, size);
    checksum = crc32(piece, checksum);
    if (!deflate.write(piece)) await once(deflate, 'drain');
    written += size;
  }
  deflate.end();
  await finished;
  return { compressed: Buffer.concat(parts), crc: checksum, uncompressedSize: totalBytes };
}

/** Minimal ZIP writer: local headers, central directory, end record. */
export function buildZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const source = entry.data ?? Buffer.alloc(0);
    const method = entry.stored ? STORED : DEFLATED;
    const payload = entry.raw ? entry.raw.compressed : entry.stored ? source : deflateRawSync(source);
    const checksum = entry.raw ? entry.raw.crc : crc32(source);
    const declared = entry.lieAboutSize ?? entry.raw?.uncompressedSize ?? source.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra
    name.copy(local, 30);
    locals.push(local, payload);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12); // time
    central.writeUInt16LE(0, 14); // date
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // start disk
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDirectory, end]);
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

/** One bullet list definition (numId 1), so list paragraphs read as a real list. */
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

function paragraph(text: string, opts: { style?: string; underline?: boolean; bullet?: boolean } = {}): string {
  const properties = [
    opts.style ? `<w:pStyle w:val="${opts.style}"/>` : '',
    opts.bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>' : '',
  ].join('');
  const runProperties = opts.underline ? '<w:rPr><w:u w:val="single"/></w:rPr>' : '';
  return `<w:p>${properties ? `<w:pPr>${properties}</w:pPr>` : ''}<w:r>${runProperties}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

/**
 * A small but genuine .docx: a Heading 1, a paragraph with an underlined run,
 * and a two-item bullet list. Enough to prove the real conversion path works.
 */
export function sampleDocx(): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${paragraph('Quarterly report', { style: 'Heading1' })}
    ${paragraph('Revenue grew steadily.', { underline: true })}
    ${paragraph('Enterprise deals', { bullet: true })}
    ${paragraph('Lower churn', { bullet: true })}
  </w:body>
</w:document>`;
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(PACKAGE_RELS, 'utf8') },
    { name: 'word/numbering.xml', data: Buffer.from(NUMBERING, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

/**
 * A .docx whose main part declares a kilobyte but really inflates to `megabytes`
 * megabytes - the shape a zip bomb takes. The archive itself stays a few
 * kilobytes, and building it never materialises the payload, so the test process
 * can safely describe a bomb far bigger than its own memory budget.
 */
export async function zipBombDocx(megabytes = 200): Promise<Buffer> {
  const payload = await deflateRepeated(0x20, megabytes * 1024 * 1024); // spaces compress ~1000:1
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(PACKAGE_RELS, 'utf8') },
    { name: 'word/document.xml', raw: payload, lieAboutSize: 1024 },
  ]);
}
