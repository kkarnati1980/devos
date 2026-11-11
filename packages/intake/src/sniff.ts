import { IngestError } from "./errors.js";

export type SpecFileFormat = "docx" | "pdf" | "md" | "html";

const EXT: Record<string, SpecFileFormat> = {
  docx: "docx",
  pdf: "pdf",
  md: "md",
  markdown: "md",
  txt: "md",
  html: "html",
  htm: "html",
};

/** Base name only, no control characters, at most 255 characters. Never used as a path. */
export function sanitizeName(name: string): string {
  const base = String(name).split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").trim();
  const chars = [...cleaned];
  if (chars.length <= 255) return cleaned || "spec";
  // Keep the extension when shortening, so the format check still sees it.
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 16 ? [...cleaned.slice(dot)] : [];
  return [...chars.slice(0, 255 - ext.length), ...ext].join("");
}

export function formatFromName(name: string): SpecFileFormat {
  const base = sanitizeName(name);
  const dot = base.lastIndexOf(".");
  const ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
  const f = EXT[ext];
  if (!f) throw new IngestError("type-unknown");
  return f;
}

const BINARY_SIGNATURES: readonly number[][] = [
  [0x50, 0x4b, 0x03, 0x04], // ZIP
  [0x50, 0x4b, 0x05, 0x06], // empty ZIP
  [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // MZ (PE)
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0x47, 0x49, 0x46, 0x38], // GIF
  [0xff, 0xd8, 0xff], // JPEG
  [0x1f, 0x8b], // gzip
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  [0x52, 0x61, 0x72, 0x21], // RAR
  [0xd0, 0xcf, 0x11, 0xe0], // OLE (.doc)
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O fat / Java class
  [0xcf, 0xfa, 0xed, 0xfe], // Mach-O
];

function startsWith(b: Uint8Array, sig: readonly number[], at = 0): boolean {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i++) if (b[at + i] !== sig[i]) return false;
  return true;
}

function findPdfHeader(b: Uint8Array): boolean {
  const end = Math.min(b.length - 5, 1024);
  for (let i = 0; i <= end; i++) if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d], i)) return true;
  return false;
}

/** Decode a text upload strictly: valid UTF-8, no NUL, no binary signature. */
export function decodeTextStrict(b: Uint8Array): string {
  for (const sig of BINARY_SIGNATURES) if (startsWith(b, sig)) throw new IngestError("type-mismatch");
  if (b.includes(0)) throw new IngestError("type-mismatch");
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(b);
  } catch {
    throw new IngestError("text-not-utf8");
  }
  return s;
}

/** Check that the bytes agree with the format the extension claims. Text formats are checked when decoded. */
export function checkMagic(b: Uint8Array, format: SpecFileFormat): void {
  if (format === "docx") {
    if (!startsWith(b, [0x50, 0x4b, 0x03, 0x04])) throw new IngestError("type-mismatch");
  } else if (format === "pdf") {
    if (!findPdfHeader(b)) throw new IngestError("type-mismatch");
  }
}
