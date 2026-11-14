// SM-03 add-on: browser safety (docs/modules/S3.md, "S3-b3 SM-03 build notes").
// SM-03-L1: a cross-origin state-changing request is refused (sameOrigin / createOriginGuard).
// SM-03-L2: output is escaped (the html`` tag) and the app's code has no raw-HTML sinks (findRawHtmlSinks).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REFUSED = JSON.stringify({ error: "cross-origin-refused" });
const protectedHandlers = new WeakSet();

// An allowed origin is exactly scheme://host[:port] for http or https: no path, query, fragment or credentials.
function canonicalOrigin(text) {
  if (typeof text !== "string" || !text) throw new TypeError("allowedOrigins: each entry must be a non-empty string");
  let u;
  try { u = new URL(text); } catch { throw new TypeError(`allowedOrigins: not a URL: ${JSON.stringify(text)}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new TypeError(`allowedOrigins: only http and https: ${JSON.stringify(text)}`);
  if (u.origin !== text) throw new TypeError(`allowedOrigins: write the bare origin ${JSON.stringify(u.origin)}, not ${JSON.stringify(text)}`);
  return u.origin;
}

function refuse(res) {
  res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(REFUSED);
}

// The decision for one request; exported for tests and for apps with their own router.
// Browsers send Origin on every cross-origin POST/PUT/PATCH/DELETE, and modern ones send Sec-Fetch-Site too.
// A request with neither header is accepted only when it carries an Authorization header, which a page on another
// origin cannot add without a CORS preflight that the core never answers (the core has no OPTIONS route).
export function originAllowed(req, origins) {
  if (!STATE_CHANGING.has(String(req.method).toUpperCase())) return true;
  const h = req.headers;
  const site = h["sec-fetch-site"];
  if (site !== undefined && site !== "same-origin") return false; // cross-site, same-site, none or anything else
  const origin = h.origin;
  if (origin !== undefined) return typeof origin === "string" && origins.has(origin); // "null" and repeats refused
  if (site === "same-origin") return true;
  return typeof h.authorization === "string" && h.authorization.length > 0;
}

export function createOriginGuard({ allowedOrigins } = {}) {
  if (!Array.isArray(allowedOrigins) || allowedOrigins.length === 0) throw new TypeError("createOriginGuard: allowedOrigins must list the app's own origin(s)");
  const origins = new Set(allowedOrigins.map(canonicalOrigin));
  const protect = (handler) => {
    if (typeof handler !== "function") throw new TypeError("protect: handler must be a function");
    const wrapped = async (req, res, ctx) => (originAllowed(req, origins) ? handler(req, res, ctx) : refuse(res));
    protectedHandlers.add(wrapped);
    return wrapped;
  };
  const protectAll = (routes) => {
    const out = {};
    for (const [key, h] of Object.entries(routes)) out[key] = protect(h);
    return out;
  };
  return { protect, protectAll, origins: [...origins] };
}

// Origins from the server environment: APP_ORIGINS="https://app.example,https://app.tailnet.ts.net".
export function originsFromEnv(env = process.env) {
  return String(env.APP_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Throws, naming every state-changing route that is not behind the origin guard.
export function assertAllProtected(routes) {
  const missing = Object.entries(routes)
    .filter(([key, h]) => STATE_CHANGING.has(key.split(" ")[0].toUpperCase()) && !protectedHandlers.has(h))
    .map(([key]) => key);
  if (missing.length) throw new Error(`state-changing routes without the origin guard: ${missing.join(", ")}`);
}

// ---------- escaped output ----------
// S3-b3 deadlock resolution (docs/modules/S3.md, 14 Nov 2026): the template may use only a fixed subset of HTML,
// read by a strict tokenizer that fails closed. Thirteen Codex rounds (PR98-r1…r13) each found a place where a
// model of the full HTML parser (foreign content, select, template, comments, bogus comments, CDATA, unquoted values)
// read markup differently from a browser. With the subset below, the browser's tokenizer state is fixed by the
// token stream alone: no allowed element changes how later text is tokenized except <title>/<textarea> (RCDATA,
// ended here only by the exact end tag) and <script> (only as an empty <script …></script>). Anything outside the
// subset makes html`` throw, so a mismatch can only refuse a page, never pass an unsafe one.

const brand = new WeakSet();
class SafeHtml {
  #text;
  constructor(text) { this.#text = text; brand.add(this); Object.freeze(this); }
  toString() { return this.#text; }
}
export const isSafeHtml = (v) => brand.has(v);

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;", "=": "&#61;" };
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`=]/g, (c) => ESC[c]);
}

export const ALLOWED_TAGS = new Set([
  "html", "head", "body", "title", "meta", "link", "script", "main", "header", "footer", "nav", "section", "article",
  "aside", "h1", "h2", "h3", "h4", "h5", "h6", "p", "div", "span", "a", "ul", "ol", "li", "dl", "dt", "dd", "table",
  "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "form", "label", "input", "button", "textarea", "img", "br",
  "hr", "strong", "em", "b", "i", "small", "code", "pre", "blockquote",
]);
export const ALLOWED_ATTRS = new Set([
  "id", "class", "title", "lang", "dir", "role", "hidden", "tabindex", "href", "rel", "target", "src", "alt", "width",
  "height", "loading", "action", "method", "for", "name", "value", "type", "placeholder", "checked", "disabled",
  "required", "readonly", "min", "max", "step", "maxlength", "autocomplete", "colspan", "rowspan", "charset",
  "content", "defer", "async",
]); // plus aria-*
const attrAllowed = (n) => ALLOWED_ATTRS.has(n) || /^aria-[a-z]+$/.test(n);
const URL_ATTRS = new Set(["href", "src", "action"]);
const CODE_TAGS = new Set(["script", "meta", "link"]); // no value in any of their attributes
const RCDATA = new Set(["title", "textarea"]);
const WS = new Set(["\t", "\n", "\f", "\r", " "]);
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", sol: "/", lpar: "(", rpar: ")", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (m, hex, dec, name) => {
    const cp = hex ? parseInt(hex, 16) : dec ? Number(dec) : NaN;
    if (Number.isFinite(cp)) return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    return NAMED[name?.toLowerCase()] ?? m;
  });
}

// A URL value is refused when it names a scheme other than http, https or mailto (javascript:, data:, vbscript:, …).
// Control characters and spaces are dropped first, as browsers do when they parse the URL.
export function isSafeUrl(value) {
  const s = String(value ?? "").replace(/[\u0000- \u007f]/g, "");
  const scheme = /^([^:/?#]*):/.exec(s);
  return !scheme || ["http", "https", "mailto"].includes(scheme[1].toLowerCase());
}

const fail = (msg) => { throw new TypeError(`html: ${msg}`); };
const DOCTYPE = "<!doctype html>";

// The strict tokenizer. Modes: text, lt ("<" seen), name, beforeAttr, attrName, eq ("=" seen), value (inside a
// double-quoted value), afterValue, selfClose, endLt ("</" seen), endName, endWs, rcdata, endExact (matching the
// one end tag allowed to leave <title>, <textarea> or <script>).
class Tokenizer {
  mode = "text"; at = 0; tag = ""; attr = ""; buf = ""; valued = false; closing = false; expect = ""; ei = 0; rc = "";
  feed(s) {
    for (let i = 0; i < s.length; i++, this.at++) {
      const c = s[i];
      const lc = c.toLowerCase();
      switch (this.mode) {
        case "text":
          if (c === "<") {
            const doctype = s.slice(i, i + DOCTYPE.length).toLowerCase() === DOCTYPE;
            if (doctype && this.at === 0) { i += DOCTYPE.length - 1; this.at += DOCTYPE.length - 1; }
            else if (doctype) fail("<!DOCTYPE html> may appear only at the very start of the page (not in a nested result)");
            else this.mode = "lt";
          }
          break;
        case "lt":
          if (c === "/") this.mode = "endLt";
          else if (/[a-z]/i.test(c)) { this.mode = "name"; this.tag = lc; }
          else fail('a "<" must start an allowed tag (write &lt; for a literal "<"); <!…>, <?…> and comments are not supported');
          break;
        case "name":
          if (/[a-z0-9]/i.test(c)) { this.tag += lc; break; }
          this.checkTag();
          if (WS.has(c)) this.mode = "beforeAttr"; else if (c === ">") this.emit(); else if (c === "/") this.mode = "selfClose";
          else fail(`unexpected ${JSON.stringify(c)} in a tag name`);
          break;
        case "beforeAttr":
          if (WS.has(c)) break;
          if (c === ">") this.emit(); else if (c === "/") this.mode = "selfClose";
          else if (/[a-z]/i.test(c)) { this.mode = "attrName"; this.attr = lc; }
          else fail(`unexpected ${JSON.stringify(c)} in <${this.tag}> (attributes are name or name="value")`);
          break;
        case "attrName":
          if (/[a-z0-9-]/i.test(c)) { this.attr += lc; break; }
          if (!attrAllowed(this.attr)) fail(`the attribute ${JSON.stringify(this.attr)} is not supported`);
          if (c === "=") this.mode = "eq"; else if (WS.has(c)) this.mode = "beforeAttr"; else if (c === ">") this.emit(); else if (c === "/") this.mode = "selfClose";
          else fail(`unexpected ${JSON.stringify(c)} after the attribute ${this.attr}`);
          break;
        case "eq":
          if (c === '"') { this.mode = "value"; this.buf = ""; this.valued = false; }
          else fail("quote every attribute value with double quotes, right after the =");
          break;
        case "value":
          if (c === '"') { this.closeValue(); this.mode = "afterValue"; } else this.buf += c;
          break;
        case "afterValue":
          if (WS.has(c)) this.mode = "beforeAttr"; else if (c === ">") this.emit(); else if (c === "/") this.mode = "selfClose";
          else fail(`a space must follow a quoted value in <${this.tag}>`);
          break;
        case "selfClose":
          if (c === ">") this.emit(); else fail('"/" in a tag must be followed by ">"');
          break;
        case "endLt":
          if (/[a-z]/i.test(c)) { this.mode = "endName"; this.tag = lc; } else fail('"</" must start an allowed end tag');
          break;
        case "endName":
          if (/[a-z0-9]/i.test(c)) { this.tag += lc; break; }
          this.checkTag();
          if (c === ">") this.mode = "text"; else if (WS.has(c)) this.mode = "endWs"; else fail("an end tag takes no attributes");
          break;
        case "endWs":
          if (c === ">") this.mode = "text"; else if (!WS.has(c)) fail("an end tag takes no attributes");
          break;
        case "rcdata":
          if (c === "<") { this.mode = "endExact"; this.ei = 1; }
          break;
        case "endExact":
          if (lc !== this.expect[this.ei]) fail(`inside <${this.rc}> the only markup allowed is ${this.expect} (write &lt; for "<")`);
          if (++this.ei === this.expect.length) this.mode = "text";
          break;
      }
    }
  }
  checkTag() { if (!ALLOWED_TAGS.has(this.tag)) fail(`<${this.tag}> is not supported (allowed: ${[...ALLOWED_TAGS].join(", ")})`); }
  closeValue() {
    if (!this.valued || !URL_ATTRS.has(this.attr)) return;
    // Judged whole when the quote closes, the way the browser reads it: entities decoded, then spaces and control
    // characters dropped (isSafeUrl). A named reference this decoder does not know is refused rather than guessed.
    for (const m of this.buf.matchAll(/&([a-z][a-z0-9]*)/gi)) {
      if (!(m[1].toLowerCase() in NAMED)) fail(`a URL attribute holding a value may not use the reference &${m[1]} (write &amp; for "&")`);
    }
    const decoded = decodeEntities(this.buf);
    if (!isSafeUrl(decoded)) fail("a URL attribute takes only http(s), mailto or relative URLs");
    // A form posts its fields (passwords included) to its action, so a value there may only make a same-origin path.
    const bare = decoded.replace(/[\u0000- \u007f]/g, "");
    if (this.attr === "action" && (/^[^:/?#]*:/.test(bare) || /^[\/\\]{2}/.test(bare))) fail("a URL attribute: a form action holding a value must be a same-origin path");
  }
  emit() {
    // <title>, <textarea> and <script> switch the browser's tokenizer whether or not the tag ends in "/>".
    if (RCDATA.has(this.tag)) { this.mode = "rcdata"; this.rc = this.tag; this.expect = `</${this.tag}>`; }
    else if (this.tag === "script") { this.mode = "endExact"; this.rc = "script"; this.expect = "</script>"; this.ei = 0; }
    else this.mode = "text";
  }
  // Where the next value would land.
  place(kind) { // kind: "text" (escaped) | "fragment" (nested html`` result)
    if (this.mode === "text") return;
    if (this.mode === "rcdata") { if (kind === "fragment") fail(`a nested html\`\` result may not be placed inside <${this.rc}>; pass text`); return; }
    if (this.mode === "value") {
      if (kind === "fragment") fail("a nested html`` result may be placed only in text, not in an attribute value");
      if (CODE_TAGS.has(this.tag)) fail(`no value may be placed in an attribute of <${this.tag}>`);
      this.valued = true;
      return;
    }
    if (this.mode === "endExact" && this.rc === "script") fail("no value may be placed inside <script>");
    fail("a value may go only in text or inside a double-quoted attribute value (never in a tag name, attribute name or end tag)");
  }
}

// html`<p>${name}</p>` escapes every value. Nested html`` results and arrays of them are kept as they are, in text
// only. The static text must use the subset above; see ALLOWED_TAGS and ALLOWED_ATTRS. Refused (TypeError): any
// other tag or attribute, <!…> (except a leading <!DOCTYPE html>), <?…>, comments, a "<" that does not start an
// allowed tag, unquoted or single-quoted values, a value or nested result anywhere but text or an allowed
// double-quoted value, any value in <script>, <meta> or <link>, a nested result inside <title>/<textarea> or an
// attribute, and a URL attribute (href, src, action) holding a value that, decoded, names a scheme other than
// http(s) or mailto. The result must end in text (not inside a tag, value, <title>, <textarea> or <script>).
export function html(strings, ...values) {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) throw new TypeError("html must be used as a tagged template");
  const tok = new Tokenizer();
  let out = "";
  const put = (piece) => { tok.feed(piece); out += piece; };
  const place = (v) => {
    if (Array.isArray(v)) { for (const x of v) place(x); return; }
    if (isSafeHtml(v)) { tok.place("fragment"); put(String(v)); return; }
    tok.place("text");
    put(escapeHtml(v));
  };
  put(strings[0]);
  for (let i = 0; i < values.length; i++) { place(values[i]); put(strings[i + 1]); }
  if (tok.mode !== "text") fail("the template must be balanced: it may not end inside a tag, attribute value, <title>, <textarea> or <script>");
  return new SafeHtml(out);
}

// Sends an html`` result; a plain string is refused, so unescaped text cannot reach the page through this path.
export function sendHtml(res, page, status = 200) {
  if (!isSafeHtml(page)) throw new TypeError("sendHtml: pass an html`` result, not a string");
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" });
  res.end(String(page));
}

// ---------- raw-HTML sink check ----------
// The patterns are assembled from pieces so this file does not match itself. Each is matched on the whole file
// (so a sink split over lines is found) and reported at the line where it starts.
const j = (...p) => p.join("");
const TEMPLATES = /\.(?:html?|xhtml|svg|vue|svelte|hbs|handlebars|mustache|njk|jinja2?|j2|ejs|liquid|twig)$/i;
// The gap before the operator may hold whitespace and JS block or line comments, which still leave an
// assignment to the HTML property. A false positive here is cheap; a missed sink is not.
const GAP = "(?:\\s|/\\*[\\s\\S]*?\\*/|//[^\\n]*\\n)*";
const ASSIGN = GAP + "(?:=(?!=)|\\+=|\\|\\|=|\\?\\?=|&&=)"; // =, +=, ||=, ??=, &&= (JSX and Vue-bind keys use =)
export const SINKS = [
  ["react-dangerously-set", new RegExp(j("dangerously", "SetInner", "HTML"))],
  ["inner-html", new RegExp(j("\\binner", "HTML\\b['\"`]?\\]?", ASSIGN))],
  ["inner-html-key", new RegExp(j("[{,]\\s*['\"`]?(?:inner|outer)", "HTML['\"`]?\\s*:"))],
  ["inner-html-bracket", new RegExp(j("\\[\\s*['\"`]inner", "HTML['\"`]\\s*\\]"))],
  ["outer-html", new RegExp(j("\\bouter", "HTML\\b['\"`]?\\]?", ASSIGN))],
  ["insert-adjacent-html", new RegExp(j("insertAdjacent", "HTML\\s*\\("))],
  ["document-write", new RegExp(j("document\\s*\\.\\s*write", "(?:ln)?\\s*\\("), "i")],
  ["create-contextual-fragment", new RegExp(j("createContextual", "Fragment\\s*\\("))],
  ["set-html-unsafe", new RegExp(j("setHTML", "Unsafe|parseHTML", "Unsafe"))],
  ["vue-vhtml-directive", new RegExp(j("\\bv-", "html\\b"))],
  ["svelte-at-html", new RegExp(j("\\{@", "html\\b"))],
  ["template-safe-filter", new RegExp(j("\\|\\s*", "safe\\b")), TEMPLATES],
  ["handlebars-triple", new RegExp(j("\\{\\{", "\\{"))],
  ["mustache-ampersand", new RegExp(j("\\{\\{", "\\s*&")), TEMPLATES],
  ["template-raw-filter", new RegExp(j("\\|\\s*", "raw\\b")), TEMPLATES],
  ["template-autoescape-off", new RegExp(j("auto", "escape\\s+(?:false|off)\\b"), "i"), TEMPLATES],
  ["ejs-unescaped", new RegExp(j("<%", "-")), TEMPLATES],
  ["angular-inner-html", new RegExp(j("\\[inner", "HTML\\]"), "i")],
  ["iframe-src-doc", new RegExp(j("\\bsrc", "doc\\b['\"`]?\\s*[=,:]"), "i")],
  ["lit-unsafe-html", new RegExp(j("\\bunsafe", "(?:HTML|SVG)\\s*\\("))],
  ["jquery-html", new RegExp(j("(?:\\$|\\bjQuery)\\s*\\([^;]*?\\.\\s*(?:html|append|prepend|before|after|replaceWith|wrap)", "\\s*\\(\\s*[^)\\s]"))],
];
const SCANNED = /\.(?:m?js|cjs|ts|mts|cts|tsx|jsx|vue|svelte|html?|xhtml|svg|hbs|handlebars|mustache|njk|jinja2?|j2|ejs|liquid|twig)$/i;

// Scans src/ and public/ of the app at `root`; returns [{ file, line, sink }] for every match.
// Comments and strings are scanned too: a false positive is cheap, a missed sink is not. Sinks the scan does not
// know (a jQuery object held in a variable, an HTML string passed through a helper) are the reviewer's (SM-03-L2 is
// "auto + review").
export function findRawHtmlSinks(root, dirs = ["src", "public"]) {
  const hits = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      // Dependencies, build output and vendored copies are not the app's own code (their sources are scanned).
      if (["node_modules", ".git", "dist", "build", "vendor"].includes(name) || /\.min\.[a-z]+$/i.test(name)) continue;
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!st.isFile() || !SCANNED.test(name)) continue;
      const text = readFileSync(p, "utf8");
      const file = relative(root, p).split(sep).join("/");
      for (const [sink, re, only] of SINKS) {
        if (only && !only.test(name)) continue;
        for (const m of text.matchAll(new RegExp(re.source, re.flags.replace("g", "") + "g"))) {
          hits.push({ file, line: text.slice(0, m.index).split("\n").length, sink });
        }
      }
    }
  };
  for (const d of dirs) walk(join(root, d));
  return hits;
}
