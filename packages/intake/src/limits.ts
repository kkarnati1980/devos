export interface IngestLimits {
  /** Largest accepted upload, bytes. */
  maxBytes: number;
  /** ZIP: most central-directory entries. */
  maxZipEntries: number;
  /** ZIP: largest declared uncompressed size of one entry, bytes. */
  maxEntryBytes: number;
  /** ZIP: largest declared uncompressed total, bytes. */
  maxTotalUncompressed: number;
  /** ZIP: largest uncompressed/compressed ratio for entries above `ratioFloorBytes`. */
  maxCompressionRatio: number;
  ratioFloorBytes: number;
  /** PDF: one inflated stream, and all inflated streams together, bytes. */
  maxPdfStreamBytes: number;
  maxPdfTotalBytes: number;
  maxPdfStreams: number;
  /** Output caps. */
  maxTextChars: number;
  maxBlocks: number;
  /** Worker sandbox. */
  parseTimeoutMs: number;
  workerHeapMb: number;
}

const MiB = 1024 * 1024;

export const DEFAULT_LIMITS: Readonly<IngestLimits> = Object.freeze({
  maxBytes: 10 * MiB,
  maxZipEntries: 2000,
  maxEntryBytes: 50 * MiB,
  maxTotalUncompressed: 100 * MiB,
  maxCompressionRatio: 100,
  ratioFloorBytes: 1 * MiB,
  maxPdfStreamBytes: 50 * MiB,
  maxPdfTotalBytes: 100 * MiB,
  maxPdfStreams: 20000,
  maxTextChars: 16_000_000,
  maxBlocks: 50_000,
  parseTimeoutMs: 20_000,
  workerHeapMb: 256,
});

export function resolveLimits(partial?: Partial<IngestLimits>): IngestLimits {
  const out: IngestLimits = { ...DEFAULT_LIMITS };
  if (partial) {
    for (const [k, v] of Object.entries(partial)) {
      if (!(k in out)) throw new TypeError(`unknown limit: ${k}`);
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw new TypeError(`limit ${k} must be a positive number`);
      (out as unknown as Record<string, number>)[k] = v;
    }
  }
  return out;
}
