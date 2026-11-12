import { crc32, inflateRawSync } from "node:zlib";
import { IngestError } from "./errors.js";
import type { IngestLimits } from "./limits.js";

/**
 * Minimal, limit-first ZIP reader for .docx. All limits are checked against the central directory before any
 * entry is inflated, and each inflate is capped at the declared size and verified (size + CRC-32).
 */
export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  private readonly buf: Buffer;
  private readonly limits: IngestLimits;

  constructor(bytes: Uint8Array, limits: IngestLimits) {
    this.buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.limits = limits;
    this.entries = this.readCentralDirectory();
  }

  private readCentralDirectory(): Map<string, ZipEntry> {
    const b = this.buf;
    if (b.length < 22) throw new IngestError("zip-corrupt");
    const minPos = Math.max(0, b.length - 22 - 65535);
    let eocd = -1;
    for (let p = b.length - 22; p >= minPos; p--) {
      if (b.readUInt32LE(p) === 0x06054b50) {
        eocd = p;
        break;
      }
    }
    if (eocd < 0) throw new IngestError("zip-corrupt");
    // ZIP64 end-of-central-directory locator right before the EOCD.
    if (eocd >= 20 && b.readUInt32LE(eocd - 20) === 0x07064b50) throw new IngestError("zip-unsupported");
    const disk = b.readUInt16LE(eocd + 4);
    const cdDisk = b.readUInt16LE(eocd + 6);
    const countThisDisk = b.readUInt16LE(eocd + 8);
    const count = b.readUInt16LE(eocd + 10);
    const cdSize = b.readUInt32LE(eocd + 12);
    const cdOffset = b.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0 || countThisDisk !== count) throw new IngestError("zip-unsupported");
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new IngestError("zip-unsupported");
    if (count > this.limits.maxZipEntries) throw new IngestError("archive-bomb");
    if (cdOffset + cdSize > eocd) throw new IngestError("zip-corrupt");

    const entries = new Map<string, ZipEntry>();
    let total = 0;
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > eocd || b.readUInt32LE(p) !== 0x02014b50) throw new IngestError("zip-corrupt");
      const flags = b.readUInt16LE(p + 8);
      const method = b.readUInt16LE(p + 10);
      const crc = b.readUInt32LE(p + 16);
      const compressedSize = b.readUInt32LE(p + 20);
      const uncompressedSize = b.readUInt32LE(p + 24);
      const nameLen = b.readUInt16LE(p + 28);
      const extraLen = b.readUInt16LE(p + 30);
      const commentLen = b.readUInt16LE(p + 32);
      const diskStart = b.readUInt16LE(p + 34);
      const localHeaderOffset = b.readUInt32LE(p + 42);
      const end = p + 46 + nameLen + extraLen + commentLen;
      if (end > eocd) throw new IngestError("zip-corrupt");
      const name = b.toString("utf8", p + 46, p + 46 + nameLen);
      p = end;

      if (flags & 0x0001 || flags & 0x0040) throw new IngestError("zip-unsupported"); // encrypted / strong encryption
      if (method !== 0 && method !== 8) throw new IngestError("zip-unsupported");
      if (diskStart !== 0) throw new IngestError("zip-unsupported");
      if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
        throw new IngestError("zip-unsupported");
      }
      if (uncompressedSize > this.limits.maxEntryBytes) throw new IngestError("archive-bomb");
      total += uncompressedSize;
      if (total > this.limits.maxTotalUncompressed) throw new IngestError("archive-bomb");
      if (uncompressedSize > this.limits.ratioFloorBytes) {
        if (compressedSize === 0 || uncompressedSize / compressedSize > this.limits.maxCompressionRatio) {
          throw new IngestError("archive-bomb");
        }
      }
      if (method === 0 && compressedSize !== uncompressedSize) throw new IngestError("zip-corrupt");
      if (entries.has(name)) throw new IngestError("zip-corrupt");
      entries.set(name, { name, method, flags, crc, compressedSize, uncompressedSize, localHeaderOffset });
    }
    return entries;
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Inflate one entry, capped at its declared size and verified against size and CRC-32. */
  read(name: string): Buffer {
    const e = this.entries.get(name);
    if (!e) throw new IngestError("docx-invalid");
    const b = this.buf;
    const h = e.localHeaderOffset;
    if (h + 30 > b.length || b.readUInt32LE(h) !== 0x04034b50) throw new IngestError("zip-corrupt");
    const nameLen = b.readUInt16LE(h + 26);
    const extraLen = b.readUInt16LE(h + 28);
    const start = h + 30 + nameLen + extraLen;
    const end = start + e.compressedSize;
    if (end > b.length) throw new IngestError("zip-corrupt");
    const data = b.subarray(start, end);
    let out: Buffer;
    if (e.method === 0) {
      out = Buffer.from(data);
    } else {
      try {
        // One extra byte so an entry that inflates past its declared size is detected, never materialised.
        out = inflateRawSync(data, { maxOutputLength: e.uncompressedSize + 1 });
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ERR_BUFFER_TOO_LARGE") throw new IngestError("archive-bomb");
        throw new IngestError("zip-corrupt");
      }
    }
    if (out.length > e.uncompressedSize) throw new IngestError("archive-bomb");
    if (out.length !== e.uncompressedSize) throw new IngestError("zip-corrupt");
    if ((crc32(out) >>> 0) !== (e.crc >>> 0)) throw new IngestError("zip-corrupt");
    return out;
  }
}
