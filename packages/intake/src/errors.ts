/** Fixed refusal codes. Messages never contain source text, paths or library messages. */
export type IngestErrorCode =
  | "empty"
  | "too-large"
  | "type-unknown"
  | "type-mismatch"
  | "text-not-utf8"
  | "zip-unsupported"
  | "zip-corrupt"
  | "archive-bomb"
  | "docx-invalid"
  | "pdf-invalid"
  | "pdf-no-text"
  | "text-too-long"
  | "too-many-blocks"
  | "parse-timeout"
  | "parse-memory"
  | "parse-failed";

const MESSAGES: Record<IngestErrorCode, string> = {
  empty: "The file is empty.",
  "too-large": "The file is larger than the allowed size.",
  "type-unknown": "This file type is not accepted (use .docx, .pdf, .md or .html).",
  "type-mismatch": "The file's contents do not match its extension.",
  "text-not-utf8": "The text file is not valid UTF-8.",
  "zip-unsupported": "The .docx archive uses an unsupported feature (encryption, ZIP64, multi-disk or compression method).",
  "zip-corrupt": "The .docx archive is damaged.",
  "archive-bomb": "The .docx archive exceeds the decompression limits.",
  "docx-invalid": "The .docx document could not be read.",
  "pdf-invalid": "The PDF could not be read.",
  "pdf-no-text": "The PDF contains no extractable text (it may be scanned).",
  "text-too-long": "The converted text is longer than the allowed size.",
  "too-many-blocks": "The document has more blocks than allowed.",
  "parse-timeout": "Converting the file took too long.",
  "parse-memory": "Converting the file used too much memory.",
  "parse-failed": "Converting the file failed.",
};

export class IngestError extends Error {
  readonly code: IngestErrorCode;
  constructor(code: IngestErrorCode) {
    super(MESSAGES[code]);
    this.name = "IngestError";
    this.code = code;
  }
}

export function isIngestErrorCode(v: unknown): v is IngestErrorCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(MESSAGES, v);
}
