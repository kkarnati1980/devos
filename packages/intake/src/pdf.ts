import { inflateSync } from "node:zlib";
import { IngestError } from "./errors.js";
import type { IngestLimits } from "./limits.js";
import { cleanText, type Block } from "./model.js";

/**
 * Text-only PDF reader: content streams (plain or FlateDecode) and the text operators Tj, TJ, ', ", T*, Td, TD,
 * Tm, BT/ET. It is deliberately small; it does not resolve fonts, so CID-encoded text is reported, not guessed.
 */

function latin1(b: Uint8Array): string {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString("latin1");
}


/**
 * PDF white space between tokens: whitespace and comments (`% … end of line`) (PR30-r11). A comment must run to
 * the end of its line, so there is exactly one way to match any stretch: no backtracking blow-up on many comments.
 */
const WS = String.raw`(?:\s|%[^\r\n]*(?![^\r\n]))+`;
const INT_OBJECT = new RegExp(String.raw`(?<![0-9])(\d{1,10})${WS}\d{1,5}${WS}obj${WS}(\d{1,12})${WS}endobj\b`, "g");
const OBJECT_HEADER = new RegExp(String.raw`(?<![0-9])(\d{1,10})${WS}(\d{1,5})${WS}obj\b`, "g");
const STREAM_TERMINATOR = new RegExp(String.raw`(\r\n|\n|\r)?endstream${WS}endobj\b`, "g");

/** Integer-valued indirect objects (`n g obj 123 endobj`, comments allowed between tokens), for indirect /Length. */
function integerCandidates(text: string): Map<number, number[]> {
  // Raw matches are only candidates (a string such as "(19 0 obj 1 endobj)" also matches); latest first.
  const ints = new Map<number, number[]>();
  for (const m of text.matchAll(INT_OBJECT)) {
    const list = ints.get(Number(m[1])) ?? [];
    list.unshift(Number(m[2]));
    ints.set(Number(m[1]), list);
  }
  return ints;
}

/** End of an unfiltered content stream: the first bare `endstream` outside literal/hex strings and comments. */
function scanPlainStreamEnd(text: string, start: number): number {
  const n = text.length;
  let i = start;
  while (i < n) {
    const c = text[i];
    if (c === "(") {
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const ch = text[i];
        if (ch === "\\") i += 2;
        else {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          i++;
        }
      }
      if (depth > 0) return -1; // unbalanced: not a text stream we can scan
    } else if (c === "%") {
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
    } else if (c === "<" && text[i + 1] === "<") {
      i += 2;
    } else if (c === "<") {
      const close = text.indexOf(">", i);
      if (close < 0) return -1;
      i = close + 1;
    } else if (c === "e" && text.startsWith("endstream", i) && (i === start || /\s/.test(text[i - 1] ?? ""))) {
      let end = i;
      while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
      return end;
    } else i++;
  }
  return -1;
}

/**
 * Where a stream's data ends (PR30-r5). The declared /Length — direct or an indirect integer object — is used when
 * `endstream` follows it. Without a usable length, an unfiltered (text) stream is scanned
 * token by token so `endstream` inside a string or comment is skipped; a filtered (binary) stream ends at the first
 * `endstream` that is followed by `endobj`.
 */
const ENDSTREAM_AT = /\s*endstream/y;
/** `endstream` (after any white space, no window) exactly at `pos`. */
function endstreamAt(text: string, pos: number): boolean {
  ENDSTREAM_AT.lastIndex = pos;
  return ENDSTREAM_AT.test(text);
}

function streamEnd(buf: Buffer, text: string, dict: string, start: number, ints: ReadonlyMap<number, readonly number[]>): number {
  // The indirect form is tried first, and the direct number must be a whole integer token that is not followed by
  // a generation number and R, so "/Length 19 0 R" can never read as a direct length of 1 (PR30-r10).
  const indirect = /\/Length\s+(\d{1,10})\s+\d{1,5}\s+R(?![A-Za-z0-9])/.exec(dict);
  const direct = indirect ? null : /\/Length\s+(\d{1,12})(?![\d.])(?!\s+\d+\s+R(?![A-Za-z0-9]))/.exec(dict);
  const lens = direct ? [Number(direct[1])] : indirect ? ints.get(Number(indirect[1])) ?? [] : [];
  // A length is used only when `endstream` really follows it (PR30-r13: a decoy candidate never passes this).
  for (const len of lens) {
    if (start + len <= buf.length && endstreamAt(text, start + len)) return start + len;
  }
  // An unfiltered (text) stream is scanned token by token, skipping strings and comments, to its real endstream.
  if (!/\/Filter\b/.test(dict)) {
    const end = scanPlainStreamEnd(text, start);
    if (end >= 0) return end;
  }
  const re = new RegExp(STREAM_TERMINATOR.source, "g");
  re.lastIndex = start;
  const m = re.exec(text);
  if (m) return m.index;
  // Last resort (a damaged file without endobj): the first endstream.
  let end = text.indexOf("endstream", start);
  if (end < 0) return -1;
  while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
  return end;
}


/** Tokenise a content stream enough to read strings, numbers, arrays and operators. */
function* contentTokens(s: string): Generator<{ t: "str"; v: string; hex: boolean } | { t: "num"; v: number } | { t: "op"; v: string } | { t: "["} | { t: "]" }> {
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i] as string;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "%") {
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
    } else if (c === "(") {
      let depth = 1;
      let v = "";
      i++;
      while (i < n && depth > 0) {
        const ch = s[i] as string;
        if (ch === "\\") {
          const nx = s[i + 1] ?? "";
          const esc: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
          if (nx in esc) {
            v += esc[nx];
            i += 2;
          } else if (/[0-7]/.test(nx)) {
            const oct = /^[0-7]{1,3}/.exec(s.slice(i + 1, i + 4))?.[0] ?? "0";
            v += String.fromCharCode(parseInt(oct, 8) & 0xff);
            i += 1 + oct.length;
          } else if (nx === "\r" || nx === "\n") {
            i += 2;
            if (nx === "\r" && s[i] === "\n") i++;
          } else {
            i++;
          }
        } else {
          if (ch === "(") depth++;
          else if (ch === ")") depth--;
          if (depth > 0) v += ch;
          i++;
        }
      }
      yield { t: "str", v, hex: false };
    } else if (c === "<" && s[i + 1] !== "<") {
      const end = s.indexOf(">", i);
      const hex = s.slice(i + 1, end < 0 ? n : end).replace(/[^0-9a-fA-F]/g, "");
      const padded = hex.length % 2 ? hex + "0" : hex;
      let v = "";
      for (let k = 0; k < padded.length; k += 2) v += String.fromCharCode(parseInt(padded.slice(k, k + 2), 16));
      yield { t: "str", v, hex: true };
      i = end < 0 ? n : end + 1;
    } else if (c === "<" || c === ">") {
      i += 2; // dictionary delimiters (inline images' dicts etc.)
    } else if (c === "[") {
      yield { t: "[" };
      i++;
    } else if (c === "]") {
      yield { t: "]" };
      i++;
    } else if (/[0-9+\-.]/.test(c)) {
      const m = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(s.slice(i, i + 32));
      if (m) {
        yield { t: "num", v: Number(m[0]) };
        i += m[0].length;
      } else i++;
    } else if (c === "/") {
      const m = /^\/[^\s/<>[\]()%{}]*/.exec(s.slice(i, i + 256));
      i += m ? m[0].length : 1;
    } else if (c === "{" || c === "}") {
      i++;
    } else {
      const m = /^[A-Za-z'"*]+/.exec(s.slice(i, i + 16));
      if (m) {
        const op = m[0];
        if (op === "BI") {
          // Skip inline image data up to EI.
          const ei = s.indexOf("EI", i + 2);
          i = ei < 0 ? n : ei + 2;
          continue;
        }
        yield { t: "op", v: op };
        i += op.length;
      } else i++;
    }
  }
}

function readable(s: string): boolean {
  if (!s) return true;
  let bad = 0;
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) bad++;
  }
  return bad / s.length < 0.1;
}

function textFromContent(content: string, warnings: Set<string>): string[] {
  const lines: string[] = [];
  let line = "";
  const newLine = () => {
    const t = cleanText(line);
    if (t) lines.push(t);
    line = "";
  };
  const nums: number[] = [];
  let arr: (string | number)[] | null = null;
  let pendingStr: string | null = null;
  const add = (s: string) => {
    if (readable(s)) line += s;
    else warnings.add("pdf-text-encoding");
  };
  for (const tok of contentTokens(content)) {
    if (tok.t === "[") {
      arr = [];
      continue;
    }
    if (tok.t === "]") continue;
    if (tok.t === "str") {
      if (arr) arr.push(tok.v);
      else pendingStr = tok.v;
      continue;
    }
    if (tok.t === "num") {
      if (arr) arr.push(tok.v);
      else nums.push(tok.v);
      continue;
    }
    switch (tok.v) {
      case "Tj":
        if (pendingStr !== null) add(pendingStr);
        break;
      case "'":
      case '"':
        newLine();
        if (pendingStr !== null) add(pendingStr);
        break;
      case "TJ":
        for (const part of arr ?? []) {
          if (typeof part === "string") add(part);
          else if (part < -200) line += " ";
        }
        break;
      case "T*":
        newLine();
        break;
      case "Td":
      case "TD": {
        const ty = nums[nums.length - 1] ?? 0;
        const tx = nums[nums.length - 2] ?? 0;
        if (Math.abs(ty) > 0.01) newLine();
        else if (tx > 0 && line && !line.endsWith(" ")) line += " ";
        break;
      }
      case "Tm":
      case "BT":
      case "ET":
        newLine();
        break;
    }
    nums.length = 0;
    arr = null;
    pendingStr = null;
  }
  newLine();
  return lines;
}

interface PdfObject {
  dict: string;
  data?: Uint8Array;
  /** Byte offset of the defining `n g obj` (or of its object stream), for file order. */
  pos: number;
}

interface PdfFile {
  objs: Map<number, PdfObject>;
  /** Trailer dictionaries found between objects (never inside one), with their offsets. */
  trailers: { pos: number; dict: string }[];
}

/** Inflate one stream under the limits; undefined (with a warning) when its filter is unsupported or it is damaged. */
function decodeStream(dict: string, raw: Uint8Array, limits: IngestLimits, warnings: Set<string>, budget: { total: number }): Uint8Array | undefined {
  const filterM = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(dict);
  const filters = filterM ? (filterM[1] ?? "").match(/\/[A-Za-z0-9]+/g) ?? [] : [];
  if (filters.length > 1 || (filters.length === 1 && filters[0] !== "/FlateDecode")) {
    warnings.add("pdf-filter-unsupported");
    return undefined;
  }
  let data = raw;
  if (filters[0] === "/FlateDecode") {
    try {
      data = inflateSync(raw, { maxOutputLength: limits.maxPdfStreamBytes });
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new IngestError("pdf-invalid");
      warnings.add("pdf-stream-damaged");
      return undefined;
    }
  }
  budget.total += data.byteLength;
  if (budget.total > limits.maxPdfTotalBytes) throw new IngestError("pdf-invalid");
  return data;
}

/** Skip one PDF token that can hide keywords: a literal string, a hex string or a comment. Returns the next index. */
function skipOpaque(text: string, i: number): number {
  const n = text.length;
  const c = text[i];
  if (c === "(") {
    let depth = 1;
    i++;
    while (i < n && depth > 0) {
      const ch = text[i];
      if (ch === "\\") i += 2;
      else {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
        i++;
      }
    }
    return Math.min(i, n);
  }
  if (c === "%") {
    while (i < n && text[i] !== "\n" && text[i] !== "\r") i++;
    return i;
  }
  if (c === "<" && text[i + 1] === "<") return i + 2; // dictionary opener: consume both, never a hex string
  if (c === "<") {
    const close = text.indexOf(">", i);
    return close < 0 ? n : close + 1;
  }
  return -1;
}

const DELIM = /[\s()<>[\]{}\/%]/;

/** Find where an object body ends: at a bare `stream` keyword (then its data start) or a bare `endobj`. */
function scanObjectBody(text: string, from: number): { kind: "stream"; keyword: number; dataStart: number } | { kind: "obj"; end: number } {
  const n = text.length;
  let i = from;
  while (i < n) {
    const skip = skipOpaque(text, i);
    if (skip >= 0) {
      i = skip;
      continue;
    }
    if (text[i] === "/") {
      // A name token (/endobj, /stream …) is never a keyword (PR30-r9): skip it whole.
      i++;
      while (i < n && !DELIM.test(text[i] ?? " ")) i++;
      continue;
    }
    const prevOk = i === 0 || DELIM.test(text[i - 1] ?? " ");
    if (prevOk && text.startsWith("endobj", i) && (i + 6 >= n || DELIM.test(text[i + 6] ?? " "))) return { kind: "obj", end: i };
    if (prevOk && text.startsWith("stream", i)) {
      const eol = /^stream(\r\n|\n|\r)/.exec(text.slice(i, i + 8));
      if (eol) return { kind: "stream", keyword: i, dataStart: i + eol[0].length };
    }
    i++;
  }
  return { kind: "obj", end: n };
}

/**
 * Keep only a dictionary's own keys (PR30-r16): everything inside nested dictionaries (/PieceInfo, /Resources,
 * annotation dicts in arrays …) is blanked, so /Contents, /Kids, /Type, /Length or /Root can only match at the
 * dictionary's own depth. Input is already string- and comment-blanked.
 */
function topLevel(s: string): string {
  const keep = /^\s*<</.test(s) ? 1 : 0;
  let depth = 0;
  let out = "";
  for (let i = 0; i < s.length; ) {
    if (s.startsWith("<<", i)) {
      depth++;
      out += depth > keep ? "  " : "<<";
      i += 2;
    } else if (s.startsWith(">>", i)) {
      out += depth > keep ? "  " : ">>";
      depth--;
      i += 2;
    } else {
      out += depth > keep ? " " : s[i];
      i++;
    }
  }
  return out;
}

/** Blank out strings and comments so structural lookups (/Kids, /Contents, /Length, /Root…) never match inside them. */
function stripStrings(s: string): string {
  let out = "";
  let i = 0;
  let last = 0;
  while (i < s.length) {
    if (s[i] === "<" && s[i + 1] === "<") {
      i += 2; // keep dictionary delimiters
      continue;
    }
    const skip = skipOpaque(s, i);
    if (skip >= 0) {
      out += s.slice(last, i) + " ";
      i = last = skip;
    } else i++;
  }
  return out + s.slice(last);
}

/** The inside of the dictionary that opens at `at` (`<<`), balanced and string/comment-aware; no size window. */
function readDict(text: string, at: number): string | null {
  if (!text.startsWith("<<", at)) return null;
  let depth = 0;
  let i = at;
  while (i < text.length) {
    if (text.startsWith("<<", i)) {
      depth++;
      i += 2;
    } else if (text.startsWith(">>", i)) {
      depth--;
      i += 2;
      if (depth === 0) return text.slice(at + 2, i - 2);
    } else {
      const skip = skipOpaque(text, i);
      i = skip >= 0 ? skip : i + 1;
    }
  }
  return null;
}

/**
 * Every indirect object, later definitions replacing earlier ones (incremental updates), including objects
 * packed in object streams (/Type /ObjStm).
 */
function collectObjects(
  buf: Buffer,
  limits: IngestLimits,
  warnings: Set<string>,
  budget: { total: number },
  ints: ReadonlyMap<number, readonly number[]>,
): PdfFile {
  const text = buf.toString("latin1");
  const objs = new Map<number, PdfObject>();
  const trailers: { pos: number; dict: string }[] = [];
  let gapStart = 0;
  // Trailers are looked for only in the text between objects, so a string inside an object cannot fake one.
  const scanGap = (from: number, to: number) => {
    const gap = text.slice(from, to).replace(/%[^\r\n]*/g, (c) => " ".repeat(c.length)); // comments never hold a trailer
    for (const t of gap.matchAll(/\btrailer\s*(?=<<)/g)) {
      const d = readDict(text, from + (t.index ?? 0) + t[0].length);
      if (d !== null) trailers.push({ pos: from + (t.index ?? 0), dict: topLevel(stripStrings(d)) });
    }
  };
  const re = new RegExp(OBJECT_HEADER.source, "g");
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = re.exec(text))) {
    if (++count > limits.maxPdfStreams * 4) throw new IngestError("pdf-invalid");
    // A header inside a comment between objects (`% 999 0 obj`) is not an object (PR30-r8). Gaps hold no strings,
    // so a '%' earlier on the same line, after the previous object, starts a comment.
    const lineStart = Math.max(gapStart, text.lastIndexOf("\n", m.index) + 1, text.lastIndexOf("\r", m.index) + 1);
    if (text.slice(lineStart, m.index).includes("%")) {
      const eol = text.slice(m.index).search(/[\r\n]/);
      re.lastIndex = eol < 0 ? text.length : m.index + eol;
      continue;
    }
    const num = Number(m[1]);
    const pos = m.index;
    scanGap(gapStart, pos);
    const bodyStart = m.index + m[0].length;
    // Object boundaries come from a token scan that skips strings and comments (PR30-r6), never a substring search.
    const body = scanObjectBody(text, bodyStart);
    if (body.kind === "stream") {
      const dict = topLevel(stripStrings(text.slice(bodyStart, body.keyword)));
      const start = body.dataStart;
      const end = streamEnd(buf, text, dict, start, ints);
      if (end < 0) break;
      const data = buf.subarray(start, end);
      objs.set(num, { dict, data, pos });
      re.lastIndex = end;
      gapStart = end;
      if (/\/Type\s*\/ObjStm\b/.test(dict)) {
        const dec = decodeStream(dict, data, limits, warnings, budget);
        if (dec) {
          const s = latin1(dec);
          const n = Number(/\/N\s+(\d+)/.exec(dict)?.[1] ?? 0);
          const first = Number(/\/First\s+(\d+)/.exec(dict)?.[1] ?? 0);
          const head = s.slice(0, first).trim().split(/\s+/).map(Number);
          for (let k = 0; k < Math.min(n, head.length / 2); k++) {
            const on = head[2 * k] ?? NaN;
            const off = head[2 * k + 1] ?? NaN;
            const next = k + 1 < n ? (head[2 * k + 3] ?? s.length - first) : s.length - first;
            if (Number.isFinite(on) && Number.isFinite(off)) objs.set(on, { dict: topLevel(stripStrings(s.slice(first + off, first + next))), pos });
          }
        }
      }
    } else {
      objs.set(num, { dict: topLevel(stripStrings(text.slice(bodyStart, body.end))), pos });
      re.lastIndex = body.end;
      gapStart = body.end;
    }
  }
  scanGap(gapStart, text.length);
  return { objs, trailers };
}

function refs(s: string): number[] {
  return [...s.matchAll(/(\d{1,10})\s+\d{1,5}\s+R\b/g)].map((x) => Number(x[1]));
}

/** The page tree's content-stream object numbers, page by page, or null when the tree cannot be resolved. */
function pageContents(file: PdfFile): number[][] | null {
  const objs = file.objs;
  // /Root comes only from trailer dictionaries (outside objects) and cross-reference streams; the one latest in the
  // file wins, whichever kind it is (PR30-r6/r7), as an incremental update appends its trailer or xref stream.
  let rootNum = NaN;
  let rootPos = -1;
  const consider = (pos: number, dict: string) => {
    const r = /\/Root\s+(\d{1,10})\s+\d{1,5}\s+R\b/.exec(dict);
    if (r && pos > rootPos) {
      rootPos = pos;
      rootNum = Number(r[1]);
    }
  };
  for (const t of file.trailers) consider(t.pos, t.dict);
  for (const o of objs.values()) if (o.data && /\/Type\s*\/XRef\b/.test(o.dict)) consider(o.pos, o.dict);
  const catalog = objs.get(rootNum)?.dict;
  const pagesRef = catalog ? /\/Pages\s+(\d{1,10})\s+\d{1,5}\s+R\b/.exec(catalog) : null;
  if (!pagesRef) return null;
  const pages: number[][] = [];
  const seen = new Set<number>();
  const walk = (num: number, depth: number): boolean => {
    if (depth > 64 || seen.has(num)) return false;
    seen.add(num);
    const d = objs.get(num)?.dict;
    if (d === undefined) return false;
    // /Kids may be a direct array or an indirect reference to one (PR30-r3).
    const direct = /\/Kids\s*\[([^\]]*)\]/.exec(d);
    const indirect = direct ? null : /\/Kids\s+(\d{1,10})\s+\d{1,5}\s+R\b/.exec(d);
    if (direct || indirect) {
      const arr = direct ? direct[1] ?? "" : /\[([^\]]*)\]/.exec(objs.get(Number(indirect?.[1]))?.dict ?? "")?.[1];
      if (arr === undefined) return false; // unresolvable /Kids: fall back to file order
      for (const k of refs(arr)) if (!walk(k, depth + 1)) return false;
      return true;
    }
    // A leaf must be a page; anything else means the tree is not understood (file-order fallback).
    if (!/\/Type\s*\/Page(?![A-Za-z])/.test(d) && !/\/Contents\b/.test(d)) return false;
    const c = /\/Contents\s*(\[[^\]]*\]|\d{1,10}\s+\d{1,5}\s+R\b)/.exec(d);
    let list = c ? refs(c[1] ?? "") : [];
    // /Contents may point to an indirect array of streams.
    if (list.length === 1 && objs.get(list[0] as number) && !objs.get(list[0] as number)?.data) {
      list = refs(objs.get(list[0] as number)?.dict ?? "");
    }
    pages.push(list);
    return true;
  };
  if (!walk(Number(pagesRef[1]), 0) || pages.length === 0 || pages.every((p) => p.length === 0)) return null;
  return pages;
}

/**
 * Object offsets from the cross-reference data (PR30-r14): the last `startxref`, then each section's /Prev chain,
 * newest entry first. Handles classic `xref` tables and cross-reference streams (/W, /Index, FlateDecode with the
 * PNG predictors). Returns type-1 entries (object number → byte offset); an unusable chain returns what was read.
 */
function readXref(buf: Buffer, text: string, limits: IngestLimits): Map<number, number> {
  const offsets = new Map<number, number>();
  const last = [...text.matchAll(/startxref\s+(\d{1,12})/g)].pop();
  let at = last ? Number(last[1]) : -1;
  const seen = new Set<number>();
  const budget = { total: 0 };
  for (let hops = 0; at >= 0 && at < text.length && !seen.has(at) && hops < 64; hops++) {
    seen.add(at);
    let prev = -1;
    if (text.startsWith("xref", at)) {
      const trailerAt = text.indexOf("trailer", at);
      if (trailerAt < 0) break;
      const table = text.slice(at + 4, trailerAt);
      const re = /(\d{1,10})\s+(\d{1,10})\s*[\r\n]+((?:\s*\d{10}\s+\d{5}\s+[nf][ \t]*[\r\n]*)*)/g;
      for (const sec of table.matchAll(re)) {
        let num = Number(sec[1]);
        for (const e of (sec[3] ?? "").matchAll(/(\d{10})\s+\d{5}\s+([nf])/g)) {
          if (e[2] === "n" && !offsets.has(num)) offsets.set(num, Number(e[1]));
          num++;
        }
      }
      const open = text.indexOf("<<", trailerAt);
      const tdict = topLevel(stripStrings(open >= 0 ? readDict(text, open) ?? "" : ""));
      const prevM = /\/Prev\s+(\d{1,12})/.exec(tdict);
      const stm = /\/XRefStm\s+(\d{1,12})/.exec(tdict);
      if (stm) readXrefStream(Number(stm[1]));
      prev = prevM ? Number(prevM[1]) : -1;
    } else {
      prev = readXrefStream(at);
    }
    at = prev;
  }
  return offsets;

  function readXrefStream(pos: number): number {
    const headRe = new RegExp(String.raw`(\d{1,10})${WS}\d{1,5}${WS}obj\b`, "y");
    headRe.lastIndex = pos;
    const head = headRe.exec(text);
    if (!head) return -1;
    const body = scanObjectBody(text, pos + head[0].length);
    if (body.kind !== "stream") return -1;
    const full = stripStrings(text.slice(pos + head[0].length, body.keyword));
    const dict = topLevel(full); // own keys; /DecodeParms (nested) is read from `full`
    if (!/\/Type\s*\/XRef\b/.test(dict)) return -1;
    const len = /\/Length\s+(\d{1,12})(?![\d.])(?!\s+\d+\s+R)/.exec(dict);
    if (!len) return -1;
    const raw = buf.subarray(body.dataStart, body.dataStart + Number(len[1]));
    let data: Uint8Array | undefined;
    try {
      data = decodeStream(dict, raw, limits, new Set(), budget);
    } catch {
      return -1;
    }
    if (!data) return -1;
    const dpAt = /\/DecodeParms\s*(?=<<)/.exec(full);
    const parms = dpAt ? readDict(full, dpAt.index + dpAt[0].length) ?? "" : "";
    const pred = Number(/\/Predictor\s+(\d+)/.exec(parms)?.[1] ?? 1);
    const w = (/\/W\s*\[([^\]]*)\]/.exec(dict)?.[1] ?? "").trim().split(/\s+/).map(Number);
    if (w.length !== 3 || w.some((x) => !Number.isInteger(x) || x < 0 || x > 8)) return -1;
    const rowLen = (w[0] ?? 0) + (w[1] ?? 0) + (w[2] ?? 0);
    if (rowLen === 0) return -1;
    if (pred >= 10) data = unPng(data, Number(/\/Columns\s+(\d+)/.exec(parms)?.[1] ?? rowLen));
    const size = Number(/\/Size\s+(\d+)/.exec(dict)?.[1] ?? 0);
    const index = (/\/Index\s*\[([^\]]*)\]/.exec(dict)?.[1] ?? `0 ${size}`).trim().split(/\s+/).map(Number);
    let row = 0;
    const field = (off: number, width: number, dflt: number) => {
      if (width === 0) return dflt;
      let v = 0;
      for (let k = 0; k < width; k++) v = v * 256 + (data?.[off + k] ?? 0);
      return v;
    };
    for (let k = 0; k + 1 < index.length; k += 2) {
      const first = index[k] ?? 0;
      const count = index[k + 1] ?? 0;
      for (let j = 0; j < count && (row + 1) * rowLen <= data.length; j++, row++) {
        const o = row * rowLen;
        const type = field(o, w[0] ?? 0, 1);
        const f2 = field(o + (w[0] ?? 0), w[1] ?? 0, 0);
        if (type === 1 && !offsets.has(first + j)) offsets.set(first + j, f2);
      }
    }
    const prevM = /\/Prev\s+(\d{1,12})/.exec(dict);
    return prevM ? Number(prevM[1]) : -1;
  }
}

/** Undo the PNG row predictors (Predictor ≥ 10) used by cross-reference streams. */
function unPng(data: Uint8Array, columns: number): Uint8Array {
  const stride = columns + 1;
  const rows = Math.floor(data.length / stride);
  const out = new Uint8Array(rows * columns);
  for (let r = 0; r < rows; r++) {
    const ft = data[r * stride] ?? 0;
    for (let c = 0; c < columns; c++) {
      const x = data[r * stride + 1 + c] ?? 0;
      const a = c > 0 ? (out[r * columns + c - 1] ?? 0) : 0;
      const b = r > 0 ? (out[(r - 1) * columns + c] ?? 0) : 0;
      const d = r > 0 && c > 0 ? (out[(r - 1) * columns + c - 1] ?? 0) : 0;
      let v = x;
      if (ft === 1) v = x + a;
      else if (ft === 2) v = x + b;
      else if (ft === 3) v = x + ((a + b) >> 1);
      else if (ft === 4) {
        const p = a + b - d;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - d);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : d);
      }
      out[r * columns + c] = v & 0xff;
    }
  }
  return out;
}

/** Integer objects at the offsets the cross-reference data names (the authoritative length source). */
function xrefIntegers(text: string, offsets: ReadonlyMap<number, number>): Map<number, number> {
  const ints = new Map<number, number>();
  // Sticky match at the exact offset over the whole text: no window, so comments of any length are fine (PR30-r15).
  const re = new RegExp(String.raw`(\d{1,10})${WS}\d{1,5}${WS}obj${WS}(\d{1,12})${WS}endobj\b`, "y");
  for (const [num, off] of offsets) {
    re.lastIndex = off;
    const m = re.exec(text);
    if (m && Number(m[1]) === num) ints.set(num, Number(m[2]));
  }
  return ints;
}

export function parsePdf(bytes: Uint8Array, limits: IngestLimits, warnings: Set<string>): Block[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const budget = { total: 0 };
  // Two passes (PR30-r13), anchored on the cross-reference data when it is usable (PR30-r14): the first uses raw integer candidates (each still checked against `endstream`); the
  // second resolves indirect /Length only from integer objects the structural scan really found, so text inside
  // strings, comments or stream data can never supply a length.
  // Integer objects named by the cross-reference data are authoritative (PR30-r14); decoys elsewhere in the file
  // (strings, comments, stream bytes) can never replace them. Only numbers the xref does not cover fall back.
  const text = buf.toString("latin1");
  const xrefInts = xrefIntegers(text, readXref(buf, text, limits));
  const candidates = integerCandidates(text);
  for (const [num, len] of xrefInts) candidates.set(num, [len]);
  const firstPass = collectObjects(buf, limits, new Set(), { total: 0 }, candidates);
  const structuralInts = new Map<number, number[]>();
  for (const [num, o] of firstPass.objs) {
    const m = /^\s*(\d{1,12})\s*$/.exec(o.dict);
    if (!o.data && m) structuralInts.set(num, [Number(m[1])]);
  }
  for (const [num, len] of xrefInts) structuralInts.set(num, [len]);
  const file = collectObjects(buf, limits, warnings, budget, structuralInts);
  const objs = file.objs;
  const blocks: Block[] = [];
  const emit = (content: string) => {
    // No substring tests on text (PR30-r4): a page without a BT operator simply yields no lines.
    if (!/\bBT\b/.test(content)) return;
    for (const line of textFromContent(content, warnings)) blocks.push({ type: "paragraph", text: line });
  };
  const pages = pageContents(file);
  if (pages) {
    // Page order from the page tree; only streams a page references (obsolete or unused streams are ignored).
    for (const list of pages) {
      const parts: string[] = [];
      for (const num of list) {
        const o = objs.get(num);
        if (!o?.data) continue;
        const dec = decodeStream(o.dict, o.data, limits, warnings, budget);
        if (dec) parts.push(latin1(dec));
      }
      emit(parts.join("\n"));
    }
  } else {
    // No resolvable page tree: fall back to file order and say so.
    warnings.add("pdf-page-order-unknown");
    // Only real stream objects found by the structural scan, in file order — never byte patterns (PR30-r7).
    const streams = [...objs.values()].filter((o): o is PdfObject & { data: Uint8Array } => !!o.data).sort((x, y) => x.pos - y.pos);
    for (const st of streams) {
      if (/\/(Type\s*\/XObject|Subtype\s*\/Image|Type\s*\/XRef|Type\s*\/ObjStm|Subtype\s*\/Type1C|Length1|Length2)/.test(st.dict)) continue;
      const dec = decodeStream(st.dict, st.data, limits, warnings, budget);
      if (!dec) continue;
      const content = latin1(dec);
      // A CMap program (ToUnicode / embedded CMap) is identified structurally: its dictionary says /Type /CMap
      // or the program starts with the /CIDInit procset — never by searching page text.
      if (/\/Type\s*\/CMap\b/.test(st.dict) || /^\s*(%[^\n]*\n\s*)*\/CIDInit\s*\/ProcSet\s+findresource\b/.test(content)) continue;
      emit(content);
    }
  }
  if (!blocks.length) throw new IngestError("pdf-no-text");
  return blocks;
}
