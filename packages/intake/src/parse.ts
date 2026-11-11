import { createHash } from "node:crypto";
import { parseDocx } from "./docx.js";
import { IngestError } from "./errors.js";
import { parseHtml } from "./html.js";
import { resolveLimits, type IngestLimits } from "./limits.js";
import { parseMarkdown } from "./markdown.js";
import { blocksPlainText, renderMarkdown, type Block } from "./model.js";
import { parsePdf } from "./pdf.js";
import { DEFAULT_ID_PREFIXES, extractRequirementIds, type RequirementId } from "./reqids.js";
import { checkMagic, decodeTextStrict, formatFromName, sanitizeName, type SpecFileFormat } from "./sniff.js";

export interface IngestOptions {
  limits?: Partial<IngestLimits>;
  /** Requirement ID prefixes (default DEFAULT_ID_PREFIXES). */
  idPrefixes?: readonly string[];
}

export interface SpecRow {
  sourceFormat: SpecFileFormat;
  originalName: string;
  fileSha256: string;
  text: string;
}

export interface IngestResult {
  format: SpecFileFormat;
  sha256: string;
  byteLength: number;
  blocks: Block[];
  text: string;
  requirementIds: RequirementId[];
  warnings: string[];
  specRow: SpecRow;
}

/** Size and type checks that run before any parsing (in the caller, before the worker starts). */
export function precheck(bytes: Uint8Array, originalName: string, limits: IngestLimits): SpecFileFormat {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("bytes must be a Uint8Array");
  if (bytes.byteLength === 0) throw new IngestError("empty");
  if (bytes.byteLength > limits.maxBytes) throw new IngestError("too-large");
  const format = formatFromName(originalName);
  checkMagic(bytes, format);
  return format;
}

/** The whole pipeline in-process. `ingest()` runs this inside a worker. */
export function parseSpec(bytes: Uint8Array, originalName: string, options: IngestOptions = {}): IngestResult {
  const limits = resolveLimits(options.limits);
  const format = precheck(bytes, originalName, limits);
  const warnings = new Set<string>();
  let blocks: Block[];
  switch (format) {
    case "md":
      blocks = parseMarkdown(decodeTextStrict(bytes));
      break;
    case "html":
      blocks = parseHtml(decodeTextStrict(bytes));
      break;
    case "docx":
      blocks = parseDocx(bytes, limits, warnings);
      break;
    case "pdf":
      blocks = parsePdf(bytes, limits, warnings);
      break;
  }
  if (blocks.length > limits.maxBlocks) throw new IngestError("too-many-blocks");
  const text = renderMarkdown(blocks);
  if (text.length > limits.maxTextChars) throw new IngestError("text-too-long");
  const requirementIds = extractRequirementIds(blocksPlainText(blocks), options.idPrefixes ?? DEFAULT_ID_PREFIXES);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    format,
    sha256,
    byteLength: bytes.byteLength,
    blocks,
    text,
    requirementIds,
    warnings: [...warnings].sort(),
    specRow: { sourceFormat: format, originalName: sanitizeName(originalName), fileSha256: sha256, text },
  };
}
