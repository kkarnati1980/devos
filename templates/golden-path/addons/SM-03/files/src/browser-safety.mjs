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

const brand = new WeakSet();
const enteredRcdata = new WeakSet(); // results whose own parse entered <title>/<textarea> text (RCDATA)
class SafeHtml {
  #text;
  constructor(text, rcdata = false) { this.#text = text; brand.add(this); if (rcdata) enteredRcdata.add(this); Object.freeze(this); }
  toString() { return this.#text; }
}
export const isSafeHtml = (v) => brand.has(v);

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;", "=": "&#61;" };
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"'`=]/g, (c) => ESC[c]);
}

// Where a value may go is decided by scanning the markup written so far (static text, escaped values and nested
// html`` results) with a small state machine: text, inside a tag, inside a quoted attribute value, inside a raw-text
// element (<script>, <style>, …) or inside a comment.
const RAW_TEXT = new Set(["script", "style", "iframe", "noscript", "xmp", "noembed", "noframes", "plaintext"]);
const RCDATA = new Set(["textarea", "title"]); // text only (escaped values are fine), no tags inside
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "poster", "data", "background", "cite", "codebase", "manifest"]);
// Tags whose attributes load or re-point code (a value there is refused whatever the attribute), and attributes that
// are code or a document themselves (srcdoc is parsed as same-origin HTML after the browser decodes it).
const CODE_TAGS = new Set(["script", "base", "object", "embed", "applet", "meta", "link", "animate", "set", "animatetransform", "animatemotion"]);
const CODE_ATTRS = new Set(["style", ["src", "doc"].join(""), "values", "to", "from", "by", "attributename"]);
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", colon: ":", tab: "\t", newline: "\n", sol: "/", lpar: "(", rpar: ")", nbsp: " " };
function decodeEntities(s) {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));?/gi, (m, hex, dec, name) => {
    const cp = hex ? parseInt(hex, 16) : dec ? Number(dec) : NaN;
    if (Number.isFinite(cp)) return cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    return NAMED[name?.toLowerCase()] ?? m;
  });
}

// End tags that switch the browser's tokenizer out of a text state (RCDATA, RAWTEXT, script data). Where this parser
// and the browser can disagree about whether such an element is open (foreign content, its HTML integration points,
// HTML elements that break out of it), the first of these end tags is where the two views meet again. So one of
// them may appear only where this parser itself reads it as an end tag: never inside a tag, a quoted attribute
// value or a comment (Codex PR98-r6). A "<" or a partial name at the end of a piece is refused there too, since the
// next value could complete it.
const TEXT_END_NAMES = ["title", "textarea", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "script", "plaintext"];
function assertNoTextEndTag(s, i) {
  if (i + 1 === s.length) throw new TypeError("html: a \"<\" may not end a piece inside a tag, attribute value or comment");
  if (s[i + 1] !== "/") return;
  const rest = s.slice(i + 2, i + 2 + 12).toLowerCase();
  for (const name of TEXT_END_NAMES) {
    const complete = rest.startsWith(name) && (i + 2 + name.length === s.length || /[\t\n\f\r />]/.test(s[i + 2 + name.length]));
    const partial = i + 2 + rest.length === s.length && rest.length < name.length && name.startsWith(rest);
    if (complete || partial) throw new TypeError(`html: </${name}> may not appear inside a tag, attribute value or comment`);
  }
}
// Start tags that open a text state, refused inside <select>: the select parsing mode ignores them in some browsers
// (so their content is markup there) and honours them in others (Codex PR98-r6). <script> is raw text in both.
const IGNORED_IN_SELECT = new Set([...RCDATA, ...RAW_TEXT].filter((n) => n !== "script"));

const CDATA_REFUSED = "html: <![CDATA[ is not supported (inside <svg>/<math> it hides markup until ]]>)";

class MarkupState {
  mode = "text"; // text | lt (a "<" ended the last piece) | tag | quote | raw | rcdata | comment | bogus
  tag = ""; // current tag source since "<"
  tagName = ""; quote = ""; quoteAt = 0; attr = ""; raw = ""; valued = false;
  fstack = []; // open SVG/MathML roots, innermost last
  get foreign() { return this.fstack.length; }
  // Codex PR98-r11: once an <svg> or <math> start tag has been seen, the rest of the parse never enters RCDATA.
  // Whether the browser is still in foreign content after an end tag depends on tree construction (an HTML element
  // inside <foreignObject> makes the browser ignore a </svg>), which this parser does not model.
  sawForeign = false;
  inSelect = false;
  sawRcdata = false; // this parse entered RCDATA (<title>/<textarea> before any SVG/MathML root) at least once
  ts = "open"; closing = false; selfClose = false; curAttr = ""; // tag sub-state, as in the HTML tokenizer
  openTag() { this.mode = "tag"; this.tag = "<"; this.tagName = ""; this.ts = "open"; this.closing = false; this.selfClose = false; this.curAttr = ""; }
  feed(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.mode === "lt") { // the "<" was the last character of the previous piece
        this.mode = "text";
        if (c === "!" && s.startsWith("![CDATA[", i)) throw new TypeError(CDATA_REFUSED);
        if (c === "!" || c === "?") this.mode = "bogus";
        else if (/[a-zA-Z\/]/.test(c)) { this.openTag(); i--; }
      } else if (this.mode === "text") {
        // Comments end as the browser ends them (Codex PR98-r8): "<!-->" and "<!--->" close at once, and inside a
        // comment both "-->" and "--!>" close it.
        if (c === "<" && s.startsWith("<!-->", i)) i += 4;
        else if (c === "<" && s.startsWith("<!--->", i)) i += 5;
        else if (c === "<" && s.startsWith("<!--", i)) { this.mode = "comment"; i += 3; }
        else if (c === "<" && i + 1 === s.length) this.mode = "lt";
        // Codex PR98-r10: inside SVG/MathML, <![CDATA[ … ]]> is a CDATA section that ends only at "]]>", so the
        // ">" and quotes inside it are text there, not the end of a bogus comment. Refused everywhere: outside foreign
        // content the browser reads it as a bogus comment instead, and a template never needs it (text is escaped).
        else if (c === "<" && s.startsWith("<![CDATA[", i)) throw new TypeError(CDATA_REFUSED);
        // Codex PR98-r7: <!…> (other than a comment), <?…> and </ not followed by a letter are bogus comments in
        // the browser: they end at the first ">", whatever quotes they hold. Read as tags, a quote there could hide
        // a value that the browser places after the ">" (e.g. inside a <script>).
        else if (c === "<" && (s[i + 1] === "!" || s[i + 1] === "?" || (s[i + 1] === "/" && !/[a-zA-Z]/.test(s[i + 2] ?? "")))) this.mode = "bogus";
        else if (c === "<" && /[a-zA-Z\/]/.test(s[i + 1])) this.openTag();
      } else if (this.mode === "bogus") {
        if (c === "<") assertNoTextEndTag(s, i);
        if (c === ">") this.mode = "text";
      } else if (this.mode === "comment") {
        if (c === "<") assertNoTextEndTag(s, i);
        if (s.startsWith("-->", i)) { this.mode = "text"; i += 2; }
        else if (s.startsWith("--!>", i)) { this.mode = "text"; i += 3; }
      } else if (this.mode === "raw" || this.mode === "rcdata") {
        // An end tag counts only with a terminator after its name, as in the browser (</scripts> does not end it).
        if (this.raw === "script" && s.startsWith("<!--", i)) throw new TypeError("html: <!-- inside <script> is not supported");
        const end = `</${this.raw}`;
        // Only ASCII whitespace, "/" or ">" ends a raw/RCDATA close tag in the HTML tokenizer. JS \s also matches
        // U+00A0 and other Unicode spaces, which the browser does NOT accept, so </script > must stay raw.
        if (c === "<" && s.slice(i, i + end.length).toLowerCase() === end && /[\t\n\f\r />]/.test(s[i + end.length] ?? "")) {
          this.openTag(); this.raw = "";
        }
      } else if (this.mode === "quote") {
        if (c === "<") assertNoTextEndTag(s, i);
        if (c === this.quote) {
          // A URL attribute that holds a value is judged as a whole when it closes, the way the browser reads it:
          // entities decoded, then leading spaces and control characters dropped (isSafeUrl).
          if (this.valued && URL_ATTRS.has(this.attr) && !isSafeUrl(decodeEntities(this.tag.slice(this.quoteAt)))) {
            throw new TypeError("html: a URL attribute takes only http(s), mailto or relative URLs");
          }
          this.mode = "tag"; this.ts = "afterQuoted"; this.quote = ""; this.valued = false;
        }
        this.tag += c;
      } else { // tag: the HTML tokenizer's tag states (Codex PR98-r9), so quotes count exactly where the browser's do
        if (c === "<") assertNoTextEndTag(s, i);
        this.tag += c;
        const ws = c === "\t" || c === "\n" || c === "\f" || c === "\r" || c === " ";
        const reconsume = (state) => { this.ts = state; this.tag = this.tag.slice(0, -1); i--; };
        let emit = false;
        switch (this.ts) {
          case "open": // just after "<"
            if (c === "/") this.closing = true; else this.tagName = c.toLowerCase();
            this.ts = "name"; break;
          case "name":
            if (ws) this.ts = "beforeAttr"; else if (c === "/") this.ts = "selfClosing"; else if (c === ">") emit = true; else this.tagName += c.toLowerCase();
            break;
          case "beforeAttr":
            if (ws) break;
            if (c === "/" || c === ">") reconsume("afterAttrName");
            else if (c === "=") { this.curAttr = "="; this.ts = "attrName"; }
            else { this.curAttr = ""; reconsume("attrName"); }
            break;
          case "attrName": // quotes and "<" are part of a name here, as in the browser
            if (ws || c === "/" || c === ">") reconsume("afterAttrName"); else if (c === "=") this.ts = "beforeValue"; else this.curAttr += c.toLowerCase();
            break;
          case "afterAttrName":
            if (ws) break;
            if (c === "/") this.ts = "selfClosing"; else if (c === "=") this.ts = "beforeValue"; else if (c === ">") emit = true; else { this.curAttr = ""; reconsume("attrName"); }
            break;
          case "beforeValue":
            if (ws) break;
            if (c === '"' || c === "'") { this.mode = "quote"; this.quote = c; this.quoteAt = this.tag.length; this.attr = this.curAttr; this.valued = false; }
            else if (c === ">") emit = true;
            else reconsume("unquoted");
            break;
          case "unquoted": // a quote here is a character of the value, not the start of one
            if (ws) this.ts = "beforeAttr"; else if (c === ">") emit = true;
            break;
          case "afterQuoted":
            if (ws) this.ts = "beforeAttr"; else if (c === "/") this.ts = "selfClosing"; else if (c === ">") emit = true; else reconsume("beforeAttr");
            break;
          case "selfClosing":
            if (c === ">") { this.selfClose = true; emit = true; } else reconsume("beforeAttr");
            break;
        }
        if (emit) {
          const name = this.closing ? "" : this.tagName;
          const closing = this.closing;
          const selfClose = this.selfClose;
          const closeName = closing ? this.tagName : "";
          // Track SVG/MathML foreign content. Inside it, <title>/<textarea> are NOT RCDATA: their children are
          // parsed as markup (SVG <title>/<desc>/<foreignObject> are HTML integration points), so a nested
          // <a href="${…}"> is a real attribute that must be URL-validated, not RCDATA text. Treating the whole
          // foreign subtree as markup only ever adds validation, never removes it, which is the safe direction.
          // An end tag pops back to its own open root, as the browser's foreign-content rule does (</math> inside an
          // <svg> is ignored there, so it must not end the SVG subtree here either).
          if (!closing && !selfClose && (name === "svg" || name === "math")) this.fstack.push(name);
          if (!closing && (name === "svg" || name === "math")) this.sawForeign = true; // a self-closed root counts too
          else if (closing && (closeName === "svg" || closeName === "math")) {
            const at = this.fstack.lastIndexOf(closeName);
            if (at >= 0) this.fstack.length = at;
          }
          if (this.foreign === 0) {
            if (!closing && name === "select") this.inSelect = true;
            else if (closing && closeName === "select") this.inSelect = false;
            else if (!closing && this.inSelect && IGNORED_IN_SELECT.has(name)) {
              throw new TypeError(`html: <${name}> inside <select> is not supported (browsers parse it differently there)`);
            }
          }
          // RCDATA only before any SVG/MathML root (r11): after one, <title>/<textarea> are read as markup, so their
          // attributes are checked. Reading RCDATA as markup only adds checks: a value there is escaped text anyway.
          const rcdata = !this.sawForeign && RCDATA.has(name);
          this.mode = !closing && RAW_TEXT.has(name) ? "raw" : !closing && rcdata ? "rcdata" : "text";
          if (this.mode !== "text") this.raw = name;
          if (this.mode === "rcdata") this.sawRcdata = true;
          this.tag = ""; this.tagName = "";
        }
      }
    }
  }
}

// A URL value is refused when it names a scheme other than http, https or mailto (javascript:, data:, vbscript:, …).
// Control characters and spaces are dropped first, as browsers do when they parse the URL.
export function isSafeUrl(value) {
  const s = String(value ?? "").replace(/[\u0000- \u007f]/g, "");
  const scheme = /^([^:/?#]*):/.exec(s);
  return !scheme || ["http", "https", "mailto"].includes(scheme[1].toLowerCase());
}

// A nested html`` result was checked as if it stood alone in element content. It is spliced verbatim, so it is
// safe only where the parent parses its text exactly that way, or as plain attribute text. Refused (TypeError):
// - inside <title>/<textarea> (RCDATA): the parent reads the fragment as text up to its first </title>, then as
//   markup, so a value the fragment saw as text could land in an attribute the parent never checked;
// - inside a quoted attribute value, when the fragment holds a quote character: it would close the attribute and
//   open new ones (e.g. title="${html`" href="${userUrl}`}") that skipped the URL and handler checks;
// - after any SVG/MathML root in the parent, when the fragment's own parse entered <title>/<textarea> text: there
//   those elements may hold markup, so the parent would read as tags and attributes what the fragment checked as text.
function assertPlaceable(v, state) {
  if (Array.isArray(v)) { for (const x of v) assertPlaceable(x, state); return; }
  if (!isSafeHtml(v)) return;
  if (state.mode === "rcdata") throw new TypeError(`html: a nested html\`\` result may not be placed inside <${state.raw}>; pass text`);
  if (state.mode === "quote" && /["']/.test(String(v))) throw new TypeError("html: a nested html`` result inside an attribute value may not hold a quote character");
  if (state.mode === "text" && state.sawForeign && enteredRcdata.has(v)) {
    throw new TypeError("html: a nested html`` result holding <title> or <textarea> text may not be placed inside <svg> or <math>");
  }
}

function renderValue(v) {
  if (isSafeHtml(v)) return String(v);
  if (Array.isArray(v)) return v.map(renderValue).join("");
  return escapeHtml(v);
}

// html`<p>${name}</p>` escapes every value. Nested html`` results and arrays of them are kept as they are.
// Refused at render (TypeError): a value inside <script>, <style> or another raw-text element or a comment; a value
// inside a tag but outside a quoted attribute value (unquoted attributes, attribute names); a value in an on…
// handler or style attribute, the iframe document attribute, an SVG animation value, or any attribute of <script>, <base>, <object>,
// <embed>, <meta> or <link>; and a URL attribute that, once complete and decoded, names a scheme other than
// http(s) or mailto (values split over several interpolations or nested html`` results are judged together).
export function html(strings, ...values) {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) throw new TypeError("html must be used as a tagged template");
  const state = new MarkupState();
  let out = strings[0];
  state.feed(strings[0]);
  for (let i = 0; i < values.length; i++) {
    if (state.mode === "bogus") throw new TypeError("html: no value may be placed inside <!…>, <?…> or </…> declarations");
    if (state.mode === "raw" || state.mode === "comment") throw new TypeError(`html: no value may be placed inside <${state.raw || "!--"}>`);
    if (state.mode === "tag" || state.mode === "lt") throw new TypeError("html: quote every attribute that holds a value (and no value may name a tag)");
    if (state.mode === "quote" && (!state.attr || state.attr.startsWith("on") || CODE_ATTRS.has(state.attr) || CODE_TAGS.has(state.tagName))) {
      throw new TypeError("html: no value may be placed in an event-handler, style, srcdoc or code-loading attribute");
    }
    if (state.mode === "quote") state.valued = true;
    assertPlaceable(values[i], state);
    const piece = renderValue(values[i]) + strings[i + 1];
    state.feed(piece);
    out += piece;
  }
  // Each result must be balanced: it may not end inside a tag, attribute, comment, raw-text element or an open
  // SVG/MathML subtree. Otherwise an unbalanced fragment could smuggle an interpolated value into an attribute
  // that a composing parent closes and reads as static — e.g. html`<a href="${userUrl}` spliced before `">` —
  // skipping the close-time URL check (which fires only when the quote holds an interpolated value).
  if (state.mode !== "text" || state.foreign !== 0) {
    throw new TypeError("html: the template must be balanced — it may not end inside a tag, attribute, comment, raw-text element or SVG/MathML subtree");
  }
  return new SafeHtml(out, state.sawRcdata);
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
