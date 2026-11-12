import { IngestError } from "./errors.js";
import type { IngestLimits } from "./limits.js";
import { cleanText, type Block } from "./model.js";
import { attr, decodeEntities, tokenize } from "./xml.js";
import { ZipArchive } from "./zip.js";

/** styleId → heading level, from word/styles.xml names ("heading 2", "Title"). */
function headingStyles(stylesXml: string | null): Map<string, number> {
  const map = new Map<string, number>();
  if (!stylesXml) return map;
  let current: string | null = null;
  for (const tok of tokenize(stylesXml)) {
    if (tok.kind === "open" && tok.name === "w:style") current = attr(tok.attrs, "w:styleId") ?? null;
    else if (tok.kind === "close" && tok.name === "w:style") current = null;
    else if (tok.kind === "open" && tok.name === "w:name" && current) {
      const name = (attr(tok.attrs, "w:val") ?? "").trim().toLowerCase();
      const m = /^heading\s*([1-9])$/.exec(name);
      if (m) map.set(current, Math.min(6, Number(m[1])));
      else if (name === "title") map.set(current, 1);
    }
  }
  return map;
}

function builtinHeading(styleId: string): number | undefined {
  if (/^title$/i.test(styleId)) return 1;
  const m = /^heading\s*([1-9])$/i.exec(styleId);
  return m ? Math.min(6, Number(m[1])) : undefined;
}

export function parseDocx(bytes: Uint8Array, limits: IngestLimits, warnings: Set<string>): Block[] {
  const zip = new ZipArchive(bytes, limits);
  if (!zip.has("[Content_Types].xml") || !zip.has("word/document.xml")) throw new IngestError("type-mismatch");
  zip.read("[Content_Types].xml"); // verified (size + CRC) even though only its presence matters
  const docXml = zip.read("word/document.xml").toString("utf8");
  const stylesXml = zip.has("word/styles.xml") ? zip.read("word/styles.xml").toString("utf8") : null;
  const styles = headingStyles(stylesXml);
  if (!/<w:document[\s>]/.test(docXml) || !/<w:body[\s>]/.test(docXml)) throw new IngestError("docx-invalid");

  const blocks: Block[] = [];
  // Table state: a stack, because tables nest inside cells.
  const tables: { rows: string[][]; row: string[] | null; cell: string[] | null }[] = [];
  let para: string | null = null;
  let pStyle = "";
  let numbered = false;
  let ilvl = 0;
  let inDel = 0;
  let inText = false;
  let inPPr = 0;

  const endPara = () => {
    if (para === null) return;
    const text = cleanText(para);
    para = null;
    const t = tables[tables.length - 1];
    if (t && t.cell) {
      if (text) t.cell.push(text);
      return;
    }
    if (!text) return;
    const level = styles.get(pStyle) ?? builtinHeading(pStyle);
    if (level) blocks.push({ type: "heading", level, text });
    else if (numbered) blocks.push({ type: "list-item", text, ordered: true, depth: Math.min(8, ilvl) });
    else blocks.push({ type: "paragraph", text });
  };

  for (const tok of tokenize(docXml)) {
    if (tok.kind === "text") {
      if (inText && !inDel && para !== null) para += decodeEntities(tok.text);
      continue;
    }
    const n = tok.name;
    if (tok.kind === "open") {
      switch (n) {
        case "w:p":
          endPara();
          para = "";
          pStyle = "";
          numbered = false;
          ilvl = 0;
          if (tok.selfClosing) endPara();
          break;
        case "w:ppr":
          if (!tok.selfClosing) inPPr++;
          break;
        case "w:pstyle":
          if (inPPr) pStyle = attr(tok.attrs, "w:val") ?? "";
          break;
        case "w:numpr":
          if (inPPr) numbered = true;
          break;
        case "w:ilvl":
          if (inPPr) ilvl = Number(attr(tok.attrs, "w:val") ?? 0) || 0;
          break;
        case "w:numid":
          if (inPPr && attr(tok.attrs, "w:val") === "0") numbered = false; // numId 0 = numbering removed
          break;
        case "w:del":
        case "w:movefrom":
          if (!tok.selfClosing) {
            inDel++;
            warnings.add("docx-tracked-deletions-skipped");
          }
          break;
        case "w:t":
          inText = !tok.selfClosing;
          break;
        case "w:tab":
          if (!inPPr && !inDel && para !== null) para += "\t";
          break;
        case "w:br":
        case "w:cr":
          if (!inDel && para !== null) para += " ";
          break;
        case "w:nobreakhyphen":
          if (!inDel && para !== null) para += "-";
          break;
        case "w:tbl":
          endPara();
          tables.push({ rows: [], row: null, cell: null });
          break;
        case "w:tr": {
          const t = tables[tables.length - 1];
          if (t) t.row = [];
          break;
        }
        case "w:tc": {
          const t = tables[tables.length - 1];
          if (t) t.cell = [];
          break;
        }
      }
      continue;
    }
    switch (n) {
      case "w:p":
        endPara();
        break;
      case "w:ppr":
        inPPr = Math.max(0, inPPr - 1);
        break;
      case "w:t":
        inText = false;
        break;
      case "w:del":
      case "w:movefrom":
        inDel = Math.max(0, inDel - 1);
        break;
      case "w:tc": {
        endPara();
        const t = tables[tables.length - 1];
        if (t && t.cell) {
          (t.row ??= []).push(t.cell.join(" "));
          t.cell = null;
        }
        break;
      }
      case "w:tr": {
        const t = tables[tables.length - 1];
        if (t && t.row) {
          if (t.row.length) t.rows.push(t.row);
          t.row = null;
        }
        break;
      }
      case "w:tbl": {
        endPara();
        const done = tables.pop();
        if (!done) break;
        const outer = tables[tables.length - 1];
        if (outer && outer.cell) outer.cell.push(done.rows.map((r) => r.join(" ")).join(" "));
        else if (done.rows.length) blocks.push({ type: "table", rows: done.rows });
        break;
      }
    }
  }
  endPara();
  return blocks;
}
