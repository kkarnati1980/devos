/** A tiny tolerant tag tokenizer shared by the HTML and DOCX readers. It never evaluates anything. */
export type Token =
  | { kind: "text"; text: string }
  | { kind: "open"; name: string; attrs: string; selfClosing: boolean }
  | { kind: "close"; name: string };

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", bull: "•",
  middot: "·", copy: "©", reg: "®", trade: "™", deg: "°", times: "×",
  le: "≤", ge: "≥", ne: "≠", rarr: "→", larr: "←", euro: "€", pound: "£",
  rupee: "₹", shy: "", zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ",
};

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, ent: string) => {
    if (ent[0] === "#") {
      const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
      return String.fromCodePoint(cp);
    }
    const v = NAMED[ent.toLowerCase()];
    return v === undefined ? whole : v;
  });
}

/**
 * Split markup into tokens. Comments, CDATA (kept as text), doctype and processing instructions are handled;
 * attribute values may contain '>'. `rawTextTags` (lower-case) swallow their content up to the matching close tag.
 */
export function tokenize(src: string, rawTextTags: ReadonlySet<string> = new Set()): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      out.push({ kind: "text", text: src.slice(i) });
      break;
    }
    if (lt > i) out.push({ kind: "text", text: src.slice(i, lt) });
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", lt)) {
      const end = src.indexOf("]]>", lt + 9);
      const body = src.slice(lt + 9, end < 0 ? n : end);
      out.push({ kind: "text", text: body.replace(/&/g, "&amp;").replace(/</g, "&lt;") });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    const m = /^<(\/?)([A-Za-z][A-Za-z0-9:_.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(src.slice(lt, Math.min(n, lt + 65536)));
    if (!m) {
      // A bare '<' is text.
      out.push({ kind: "text", text: "&lt;" });
      i = lt + 1;
      continue;
    }
    const name = (m[2] ?? "").toLowerCase();
    i = lt + m[0].length;
    if (m[1]) {
      out.push({ kind: "close", name });
      continue;
    }
    const attrs = m[3] ?? "";
    const selfClosing = /\/\s*$/.test(attrs);
    out.push({ kind: "open", name, attrs, selfClosing });
    if (!selfClosing && rawTextTags.has(name)) {
      const re = new RegExp(`</${name.replace(/[.]/g, "\\.")}\\s*>`, "gi");
      re.lastIndex = i;
      const close = re.exec(src);
      i = close ? close.index + close[0].length : n;
      out.push({ kind: "close", name });
    }
  }
  return out;
}

/** Read one attribute value (already lower-cased name match, value entity-decoded). */
export function attr(attrs: string, name: string): string | undefined {
  const re = /([A-Za-z_:][A-Za-z0-9:_.-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  for (const m of attrs.matchAll(re)) {
    if ((m[1] ?? "").toLowerCase() === name.toLowerCase()) return decodeEntities(m[3] ?? m[4] ?? m[5] ?? "");
  }
  return undefined;
}
