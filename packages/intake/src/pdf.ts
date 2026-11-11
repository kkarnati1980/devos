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
function streamEnd(buf: Buffer, text: string, dict: string, start: number, ints: ReadonlyMap<number, readonly number[]>): number {
  // The indirect form is tried first, and the direct number must be a whole integer token that is not followed by
  // a generation number and R, so "/Length 19 0 R" can never read as a direct length of 1 (PR30-r10).
  const indirect = /\/Length\s+(\d{1,10})\s+\d{1,5}\s+R(?![A-Za-z0-9])/.exec(dict);
  const direct = indirect ? null : /\/Length\s+(\d{1,12})(?![\d.])(?!\s+\d+\s+R(?![A-Za-z0-9]))/.exec(dict);
  const lens = direct ? [Number(direct[1])] : indirect ? ints.get(Number(indirect[1])) ?? [] : [];
  // A length is used only when `endstream` really follows it (PR30-r13: a decoy candidate never passes this).
  for (const len of lens) {
    if (start + len <= buf.length && /^\s*endstream/.test(text.slice(start + len, start + len + 20))) return start + len;
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
    for (const t of gap.matchAll(/\btrailer\s*<<([\s\S]{0,4096}?)>>/g)) trailers.push({ pos: from + (t.index ?? 0), dict: stripStrings(t[1] ?? "") });
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
      const dict = stripStrings(text.slice(bodyStart, body.keyword));
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
            if (Number.isFinite(on) && Number.isFinite(off)) objs.set(on, { dict: stripStrings(s.slice(first + off, first + next)), pos });
          }
        }
      }
    } else {
      objs.set(num, { dict: stripStrings(text.slice(bodyStart, body.end)), pos });
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

export function parsePdf(bytes: Uint8Array, limits: IngestLimits, warnings: Set<string>): Block[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const budget = { total: 0 };
  // Two passes (PR30-r13): the first uses raw integer candidates (each still checked against `endstream`); the
  // second resolves indirect /Length only from integer objects the structural scan really found, so text inside
  // strings, comments or stream data can never supply a length.
  const firstPass = collectObjects(buf, limits, new Set(), { total: 0 }, integerCandidates(buf.toString("latin1")));
  const structuralInts = new Map<number, number[]>();
  for (const [num, o] of firstPass.objs) {
    const m = /^\s*(\d{1,12})\s*$/.exec(o.dict);
    if (!o.data && m) structuralInts.set(num, [Number(m[1])]);
  }
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
