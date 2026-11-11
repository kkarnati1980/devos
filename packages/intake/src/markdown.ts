import { cleanText, type Block } from "./model.js";
import { decodeEntities } from "./xml.js";

/** Remove raw <script>/<style> blocks (and unterminated openers) from Markdown; other HTML stays as text. */
function stripActive(src: string): string {
  return src
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*$/gi, "");
}

function isTableRow(line: string): boolean {
  return /^\s*\|.*\|\s*$/.test(line) || (/\|/.test(line) && /^\s*[^|]+\|/.test(line) && line.split("|").length >= 3);
}

function isDelimiterRow(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => inline(c.replace(/\\\|/g, "|")));
}

/** Inline Markdown to plain text: drop emphasis marks, keep link text, decode entities. */
function inline(s: string): string {
  return cleanText(
    decodeEntities(
      s
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/`([^`]*)`/g, "$1")
        .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
        .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*/g, "$1$2"),
    ),
  );
}

export function parseMarkdown(src: string): Block[] {
  const lines = stripActive(src.replace(/\r\n?/g, "\n")).split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  const flush = () => {
    const t = inline(para.join(" "));
    if (t) blocks.push({ type: "paragraph", text: t });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fence = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flush();
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(marker)) body.push(lines[i++] ?? "");
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    const atx = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (atx) {
      flush();
      blocks.push({ type: "heading", level: (atx[1] ?? "#").length, text: inline(atx[2] ?? "") });
      continue;
    }
    const next = lines[i + 1] ?? "";
    if (para.length === 0 && line.trim() && /^\s{0,3}(=+|-+)\s*$/.test(next) && !/^\s*[-*+]\s/.test(line)) {
      blocks.push({ type: "heading", level: next.trim().startsWith("=") ? 1 : 2, text: inline(line) });
      i++;
      continue;
    }
    if (isTableRow(line) && isDelimiterRow(next)) {
      flush();
      const rows: string[][] = [splitRow(line)];
      i += 2;
      while (i < lines.length && (lines[i] ?? "").trim() && isTableRow(lines[i] ?? "")) rows.push(splitRow(lines[i++] ?? ""));
      i--;
      blocks.push({ type: "table", rows });
      continue;
    }
    const li = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const indent = (li[1] ?? "").replace(/\t/g, "    ").length;
      blocks.push({ type: "list-item", text: inline(li[3] ?? ""), ordered: /\d/.test(li[2] ?? ""), depth: Math.floor(indent / 2) });
      continue;
    }
    const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
    para.push(quote ? (quote[1] ?? "") : line);
  }
  flush();
  return blocks;
}
