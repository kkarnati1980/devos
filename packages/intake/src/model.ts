export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | { type: "list-item"; text: string; ordered: boolean; depth: number }
  | { type: "table"; rows: string[][] }
  | { type: "code"; text: string };

/** Collapse runs of whitespace (not newlines inside code) and trim. */
export function cleanText(s: string): string {
  return s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").replace(/[ \t\r\n ]+/g, " ").trim();
}

/** Escape the three HTML-significant characters so spec text can never become markup. */
export function escapeInert(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cell(s: string): string {
  return escapeInert(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/** Render blocks as inert Markdown. */
export function renderMarkdown(blocks: readonly Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "heading":
        out.push(`${"#".repeat(Math.min(6, Math.max(1, b.level)))} ${escapeInert(b.text)}`);
        break;
      case "paragraph":
        out.push(escapeInert(b.text));
        break;
      case "list-item": {
        const indent = "  ".repeat(Math.max(0, Math.min(8, b.depth)));
        out.push(`${indent}${b.ordered ? "1." : "-"} ${escapeInert(b.text)}`);
        break;
      }
      case "table": {
        if (b.rows.length === 0) break;
        const width = Math.max(...b.rows.map((r) => r.length), 1);
        const pad = (r: string[]) => Array.from({ length: width }, (_, i) => cell(r[i] ?? ""));
        const lines = [`| ${pad(b.rows[0] ?? []).join(" | ")} |`, `|${" --- |".repeat(width)}`];
        for (const r of b.rows.slice(1)) lines.push(`| ${pad(r).join(" | ")} |`);
        out.push(lines.join("\n"));
        break;
      }
      case "code": {
        const fence = b.text.includes("```") ? "~~~~" : "```";
        out.push(`${fence}\n${escapeInert(b.text)}\n${fence}`);
        break;
      }
    }
  }
  // Join list items tightly, other blocks with a blank line.
  let text = "";
  for (let i = 0; i < out.length; i++) {
    if (i > 0) {
      const prev = blocks[i - 1];
      const cur = blocks[i];
      text += prev?.type === "list-item" && cur?.type === "list-item" ? "\n" : "\n\n";
    }
    text += out[i];
  }
  return text.length ? text + "\n" : "";
}

/** All human-visible text of the blocks, one block per line (used for ID extraction). */
export function blocksPlainText(blocks: readonly Block[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === "table") for (const r of b.rows) parts.push(r.join(" \t "));
    else parts.push(b.text);
  }
  return parts.join("\n");
}
