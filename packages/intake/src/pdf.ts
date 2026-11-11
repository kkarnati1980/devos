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

interface RawStream {
  dict: string;
  data: Uint8Array;
}

function findStreams(buf: Buffer, limits: IngestLimits): RawStream[] {
  const out: RawStream[] = [];
  const text = buf.toString("latin1");
  const re = /stream(\r\n|\n|\r)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const kw = m.index;
    // Must be the keyword after a dictionary, not part of "endstream".
    if (kw >= 3 && text.slice(kw - 3, kw) === "end") continue;
    const dictEnd = text.lastIndexOf(">>", kw);
    const objStart = text.lastIndexOf(" obj", kw);
    if (dictEnd < 0 || objStart < 0 || dictEnd < objStart) continue;
    const dict = text.slice(objStart, dictEnd + 2);
    const start = kw + m[0].length;
    let end = -1;
    const lenM = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    if (lenM) {
      const len = Number(lenM[1]);
      if (start + len <= buf.length && /^\s*endstream/.test(text.slice(start + len, start + len + 20))) end = start + len;
    }
    if (end < 0) {
      end = text.indexOf("endstream", start);
      if (end < 0) break;
      while (end > start && (text[end - 1] === "\n" || text[end - 1] === "\r")) end--;
    }
    out.push({ dict, data: buf.subarray(start, end) });
    if (out.length > limits.maxPdfStreams) throw new IngestError("pdf-invalid");
    re.lastIndex = end;
  }
  return out;
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

export function parsePdf(bytes: Uint8Array, limits: IngestLimits, warnings: Set<string>): Block[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const streams = findStreams(buf, limits);
  let total = 0;
  const blocks: Block[] = [];
  for (const st of streams) {
    const filterM = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/.exec(st.dict);
    const filters = filterM ? (filterM[1] ?? "").match(/\/[A-Za-z0-9]+/g) ?? [] : [];
    if (/\/(Type\s*\/XObject|Subtype\s*\/Image|Type\s*\/XRef|Type\s*\/ObjStm|Subtype\s*\/Type1C|Length1|Length2)/.test(st.dict)) continue;
    let data: Uint8Array = st.data;
    if (filters.length > 1 || (filters.length === 1 && filters[0] !== "/FlateDecode")) {
      warnings.add("pdf-filter-unsupported");
      continue;
    }
    if (filters[0] === "/FlateDecode") {
      try {
        data = inflateSync(st.data, { maxOutputLength: limits.maxPdfStreamBytes });
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") throw new IngestError("pdf-invalid");
        warnings.add("pdf-stream-damaged");
        continue;
      }
    }
    total += data.byteLength;
    if (total > limits.maxPdfTotalBytes) throw new IngestError("pdf-invalid");
    const content = latin1(data);
    if (!/\bBT\b/.test(content) || /begincmap/.test(content)) continue;
    for (const line of textFromContent(content, warnings)) blocks.push({ type: "paragraph", text: line });
  }
  if (!blocks.length) throw new IngestError("pdf-no-text");
  return blocks;
}
