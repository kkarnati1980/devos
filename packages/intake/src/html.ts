import { cleanText, type Block } from "./model.js";
import { decodeEntities, tokenize } from "./xml.js";

/** Elements whose whole content is dropped: active or non-document content. */
const DROP = new Set([
  "script", "style", "template", "noscript", "iframe", "object", "embed", "svg", "math", "canvas",
  "head", "title", "select", "textarea", "button", "audio", "video", "applet", "frameset", "frame",
]);
/** Raw-text elements: the tokenizer must not parse their content as markup. */
const RAW = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp", "plaintext", "iframe"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "embed", "param", "source", "track", "wbr"]);
const BLOCK = new Set([
  "p", "div", "section", "article", "main", "header", "footer", "aside", "nav", "blockquote", "figure",
  "figcaption", "address", "dl", "dt", "dd", "body", "html", "hr", "caption", "details", "summary",
]);

/**
 * Convert HTML to blocks. Only text is kept: every attribute (so every on* handler and javascript: URL) is
 * discarded, and active elements are dropped with their content.
 */
export function parseHtml(src: string): Block[] {
  const tokens = tokenize(src, RAW);
  const blocks: Block[] = [];
  let buf = "";
  let drop = 0;
  const dropStack: string[] = [];
  let heading = 0;
  let pre = 0;
  const lists: boolean[] = [];
  let inLi = false;
  let table: string[][] | null = null;
  let row: string[] | null = null;
  let cellBuf: string | null = null;
  const tableStack: { table: string[][]; row: string[] | null; cell: string | null }[] = [];

  const emit = () => {
    if (cellBuf !== null) {
      cellBuf += " "; // a block boundary inside a cell separates its text (PR30-r9)
      return;
    }
    if (pre) {
      const t = buf.replace(/^\n+|\s+$/g, "");
      if (t) blocks.push({ type: "code", text: t });
      buf = "";
      return;
    }
    const t = cleanText(buf);
    buf = "";
    if (!t) return;
    if (heading) blocks.push({ type: "heading", level: heading, text: t });
    else if (inLi) blocks.push({ type: "list-item", text: t, ordered: lists[lists.length - 1] ?? false, depth: Math.max(0, lists.length - 1) });
    else blocks.push({ type: "paragraph", text: t });
  };

  for (const tok of tokens) {
    if (drop) {
      if (tok.kind === "open" && DROP.has(tok.name) && !tok.selfClosing && !VOID.has(tok.name)) {
        dropStack.push(tok.name);
        drop++;
      } else if (tok.kind === "close" && dropStack[dropStack.length - 1] === tok.name) {
        dropStack.pop();
        drop--;
      }
      continue;
    }
    if (tok.kind === "text") {
      const t = decodeEntities(tok.text);
      if (cellBuf !== null) cellBuf += t;
      else buf += t;
      continue;
    }
    const name = tok.name;
    if (tok.kind === "open") {
      if (DROP.has(name)) {
        if (!tok.selfClosing && !VOID.has(name)) {
          dropStack.push(name);
          drop++;
        }
        continue;
      }
      if (/^h[1-6]$/.test(name)) {
        emit();
        heading = Number(name[1]);
      } else if (name === "ul" || name === "ol") {
        emit();
        if (inLi) inLi = false;
        lists.push(name === "ol");
      } else if (name === "li") {
        emit();
        inLi = true;
      } else if (name === "pre") {
        emit();
        pre++;
      } else if (name === "table") {
        emit();
        if (table) tableStack.push({ table, row, cell: cellBuf });
        table = [];
        row = null;
        cellBuf = null;
      } else if (name === "tr" && table) {
        if (row && row.length) table.push(row);
        row = [];
      } else if ((name === "td" || name === "th") && table) {
        if (!row) row = [];
        if (cellBuf !== null) row.push(cleanText(cellBuf));
        cellBuf = "";
      } else if (name === "br") {
        if (cellBuf !== null) cellBuf += " ";
        else if (pre) buf += "\n";
        else emit();
      } else if (BLOCK.has(name)) {
        emit();
      }
      continue;
    }
    // close
    if (/^h[1-6]$/.test(name)) {
      emit();
      heading = 0;
    } else if (name === "li") {
      emit();
      inLi = false;
    } else if (name === "ul" || name === "ol") {
      emit();
      lists.pop();
      inLi = lists.length > 0;
    } else if (name === "pre") {
      emit();
      pre = Math.max(0, pre - 1);
    } else if ((name === "td" || name === "th") && table) {
      if (row && cellBuf !== null) row.push(cleanText(cellBuf));
      cellBuf = null;
    } else if (name === "tr" && table) {
      if (cellBuf !== null && row) row.push(cleanText(cellBuf));
      cellBuf = null;
      if (row && row.length) table.push(row);
      row = null;
    } else if (name === "table" && table) {
      if (cellBuf !== null && row) row.push(cleanText(cellBuf));
      if (row && row.length) table.push(row);
      const done = table;
      const outer = tableStack.pop();
      if (outer) {
        // A nested table is flattened into the enclosing cell's text.
        table = outer.table;
        row = outer.row;
        cellBuf = (outer.cell ?? "") + " " + done.map((r) => r.join(" ")).join(" ");
      } else {
        table = null;
        row = null;
        cellBuf = null;
        if (done.length) blocks.push({ type: "table", rows: done });
      }
    } else if (BLOCK.has(name)) {
      emit();
    }
  }
  if (table) {
    if (cellBuf !== null && row) row.push(cleanText(cellBuf));
    if (row && row.length) table.push(row);
    cellBuf = null;
    if (table.length) blocks.push({ type: "table", rows: table });
  }
  emit();
  return blocks;
}
