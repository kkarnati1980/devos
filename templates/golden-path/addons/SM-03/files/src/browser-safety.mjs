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

// Where a value may go is decided by scanning the markup written so far (static text, escaped values and nested
// html`` results) with a small state machine: text, inside a tag, inside a quoted attribute value, inside a raw-text
// element (<script>, <style>, …) or inside a comment.
const RAW_TEXT = new Set(["script", "style", "iframe", "noscript", "xmp", "noembed", "noframes", "plaintext"]);
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

class MarkupState {
  mode = "text"; // text | tag | quote | raw | comment
  tag = ""; // current tag source since "<"
  tagName = ""; quote = ""; quoteAt = 0; attr = ""; raw = ""; valued = false;
  feed(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.mode === "text") {
        if (c === "<" && s.startsWith("<!--", i)) { this.mode = "comment"; i += 3; }
        else if (c === "<" && /[a-zA-Z\/!?]/.test(s[i + 1] ?? "")) { this.mode = "tag"; this.tag = "<"; this.tagName = ""; }
      } else if (this.mode === "comment") {
        if (s.startsWith("-->", i)) { this.mode = "text"; i += 2; }
      } else if (this.mode === "raw") {
        if (c === "<" && s.slice(i, i + 2 + this.raw.length).toLowerCase() === `</${this.raw}`) { this.mode = "tag"; this.tag = "<"; this.tagName = ""; this.raw = ""; }
      } else if (this.mode === "quote") {
        if (c === this.quote) {
          // A URL attribute that holds a value is judged as a whole when it closes, the way the browser reads it:
          // entities decoded, then leading spaces and control characters dropped (isSafeUrl).
          if (this.valued && URL_ATTRS.has(this.attr) && !isSafeUrl(decodeEntities(this.tag.slice(this.quoteAt)))) {
            throw new TypeError("html: a URL attribute takes only http(s), mailto or relative URLs");
          }
          this.mode = "tag"; this.quote = ""; this.valued = false;
        }
        this.tag += c;
      } else { // tag
        this.tag += c;
        if (!this.tagName && /[\s/>"']/.test(c)) this.tagName = (/^<([a-zA-Z][^\s/>"']*)/.exec(this.tag)?.[1] ?? "-").toLowerCase();
        if (c === '"' || c === "'") {
          const m = /([^\s"'=<>\/]+)\s*=\s*$/.exec(this.tag.slice(0, -1));
          this.mode = "quote"; this.quote = c; this.quoteAt = this.tag.length; this.attr = m ? m[1].toLowerCase() : ""; this.valued = false;
        } else if (c === ">") {
          const name = this.tagName;
          this.mode = name && RAW_TEXT.has(name) ? "raw" : "text";
          if (this.mode === "raw") this.raw = name;
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
    if (state.mode === "raw" || state.mode === "comment") throw new TypeError(`html: no value may be placed inside <${state.raw || "!--"}>`);
    if (state.mode === "tag") throw new TypeError("html: quote every attribute that holds a value");
    if (state.mode === "quote" && (!state.attr || state.attr.startsWith("on") || CODE_ATTRS.has(state.attr) || CODE_TAGS.has(state.tagName))) {
      throw new TypeError("html: no value may be placed in an event-handler, style, srcdoc or code-loading attribute");
    }
    if (state.mode === "quote") state.valued = true;
    const piece = renderValue(values[i]) + strings[i + 1];
    state.feed(piece);
    out += piece;
  }
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
const ASSIGN = "\\s*(?:=(?!=)|\\+=|\\|\\|=|\\?\\?=|&&=|:)"; // =, +=, ||=, ??=, &&=, and object/JSX/Vue-bind keys
export const SINKS = [
  ["react-dangerously-set", new RegExp(j("dangerously", "SetInner", "HTML"))],
  ["inner-html", new RegExp(j("\\binner", "HTML\\b['\"`]?\\]?", ASSIGN))],
  ["inner-html-bracket", new RegExp(j("\\[\\s*['\"`]inner", "HTML['\"`]\\s*\\]"))],
  ["outer-html", new RegExp(j("\\bouter", "HTML\\b['\"`]?\\]?", ASSIGN))],
  ["insert-adjacent-html", new RegExp(j("insertAdjacent", "HTML\\s*\\("))],
  ["document-write", new RegExp(j("document\\s*\\.\\s*write", "(?:ln)?\\s*\\("))],
  ["create-contextual-fragment", new RegExp(j("createContextual", "Fragment\\s*\\("))],
  ["set-html-unsafe", new RegExp(j("setHTML", "Unsafe|parseHTML", "Unsafe"))],
  ["vue-vhtml-directive", new RegExp(j("\\bv-", "html\\b"))],
  ["svelte-at-html", new RegExp(j("\\{@", "html\\b"))],
  ["template-safe-filter", new RegExp(j("\\|\\s*", "safe\\b")), TEMPLATES],
  ["handlebars-triple", new RegExp(j("\\{\\{", "\\{"))],
  ["mustache-ampersand", new RegExp(j("\\{\\{", "\\s*&")), TEMPLATES],
  ["ejs-unescaped", new RegExp(j("<%", "-")), TEMPLATES],
  ["angular-inner-html", new RegExp(j("\\[inner", "HTML\\]"), "i")],
  ["iframe-src-doc", new RegExp(j("\\bsrc", "doc\\b['\"`]?\\s*[=,:]"), "i")],
  ["lit-unsafe-html", new RegExp(j("\\bunsafe", "(?:HTML|SVG)\\s*\\("))],
  ["jquery-html", new RegExp(j("(?:\\$|\\bjQuery)\\s*\\([^()]*\\)\\s*\\.\\s*(?:html|append|prepend|before|after|replaceWith|wrap)", "\\s*\\(\\s*[^)\\s]"))],
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
      if (name === "node_modules" || name === ".git") continue;
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
