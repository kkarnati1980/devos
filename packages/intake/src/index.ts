export { ingest } from "./ingest.js";
export { parseSpec, precheck, type IngestOptions, type IngestResult, type SpecRow } from "./parse.js";
export { IngestError, type IngestErrorCode } from "./errors.js";
export { DEFAULT_LIMITS, resolveLimits, type IngestLimits } from "./limits.js";
export { renderMarkdown, escapeInert, escapeHtmlChars, type Block } from "./model.js";
export { extractRequirementIds, DEFAULT_ID_PREFIXES, type RequirementId } from "./reqids.js";
export { sanitizeName, type SpecFileFormat } from "./sniff.js";
