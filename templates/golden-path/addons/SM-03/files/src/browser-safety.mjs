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
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "xlink:href", "srcset", "poster", "data", "background", "ping", "cite", "codebase", "manifest"]);

class MarkupState {
  mode = "text"; // text | tag | quote | raw | comment
  tag = ""; // current tag source since "<"
  quote = ""; quoteAt = 0; attr = ""; raw = "";
  feed(s) {
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (this.mode === "text") {
        if (c === "<" && s.startsWith("<!--", i)) { this.mode = "comment"; i += 3; }
        else if (c === "<" && /[a-zA-Z\/!?]/.test(s[i + 1] ?? "")) { this.mode = "tag"; this.tag = "<"; }
      } else if (this.mode === "comment") {
        if (s.startsWith("-->", i)) { this.mode = "text"; i += 2; }
      } else if (this.mode === "raw") {
        if (c === "<" && s.slice(i, i + 2 + this.raw.length).toLowerCase() === `</${this.raw}`) { this.mode = "tag"; this.tag = "<"; this.raw = ""; }
      } else if (this.mode === "quote") {
        this.tag += c;
        if (c === this.quote) { this.mode = "tag"; this.quote = ""; }
      } else { // tag
        this.tag += c;
        if (c === '"' || c === "'") {
          const m = /([^\s"'=<>\/]+)\s*=\s*$/.exec(this.tag.slice(0, -1));
          this.mode = "quote"; this.quote = c; this.quoteAt = this.tag.length; this.attr = m ? m[1].toLowerCase() : "";
        } else if (c === ">") {
          const name = /^<([a-zA-Z][^\s/>]*)/.exec(this.tag)?.[1]?.toLowerCase();
          this.mode = name && RAW_TEXT.has(name) ? "raw" : "text";
          if (this.mode === "raw") this.raw = name;
          this.tag = "";
        }
      }
    }
  }
}

// A URL value is refused when it names a scheme other than http, https or mailto (javascript:, data:, vbscript:, …).
// Control characters and spaces are dropped first, as browsers do when they parse the URL.
export function isSafeUrl(value) {
  const s = String(value ?? "").replace(/[\u0000-\u0020\u007f]/g, "");
  const scheme = /^([^:/?#]*):/.exec(s);
  return !scheme || ["http", "https", "mailto"].includes(scheme[1].toLowerCase());
}

function renderValue(v, state) {
  if (isSafeHtml(v)) return String(v);
  if (Array.isArray(v)) return v.map((x) => renderValue(x, state)).join("");
  if (state.mode === "quote" && URL_ATTRS.has(state.attr) && state.tag.length === state.quoteAt && !isSafeUrl(v)) {
    throw new TypeError("html: a URL attribute takes only http(s), mailto or relative URLs");
  }
  return escapeHtml(v);
}

// html`<p>${name}</p>` escapes every value. Nested html`` results and arrays of them are kept as they are.
// Refused at render (TypeError): a value inside <script>, <style> or another raw-text element or a comment; a value
// inside a tag but outside a quoted attribute value (unquoted attributes, attribute names); a value in an on…
// handler or style attribute; and a URL attribute that starts with a scheme other than http(s) or mailto.
export function html(strings, ...values) {
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) throw new TypeError("html must be used as a tagged template");
  const state = new MarkupState();
  let out = strings[0];
  state.feed(strings[0]);
  for (let i = 0; i < values.length; i++) {
    if (state.mode === "raw" || state.mode === "comment") throw new TypeError(`html: no value may be placed inside <${state.raw || "!--"}>`);
    if (state.mode === "tag") throw new TypeError("html: quote every attribute that holds a value");
    if (state.mode === "quote" && (state.attr.startsWith("on") || state.attr === "style" || !state.attr)) throw new TypeError("html: no value may be placed in an event-handler or style attribute");
    const piece = renderValue(values[i], state) + strings[i + 1];
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
// The patterns are assembled from pieces so this file does not match itself.
const j = (...p) => p.join("");
export const SINKS = [
  ["react-dangerously-set", new RegExp(j("dangerously", "SetInner", "HTML"))],
  ["inner-html", new RegExp(j("\\.\\s*inner", "HTML\\s*\\+?=(?!=)"))],
  ["inner-html-bracket", new RegExp(j("\\[\\s*['\"`]inner", "HTML['\"`]\\s*\\]"))],
  ["outer-html", new RegExp(j("\\.\\s*outer", "HTML\\s*\\+?=(?!=)"))],
  ["insert-adjacent-html", new RegExp(j("insertAdjacent", "HTML\\s*\\("))],
  ["document-write", new RegExp(j("document\\s*\\.\\s*write", "(?:ln)?\\s*\\("))],
  ["create-contextual-fragment", new RegExp(j("createContextual", "Fragment\\s*\\("))],
  ["set-html-unsafe", new RegExp(j("setHTML", "Unsafe|parseHTML", "Unsafe"))],
  ["vue-vhtml-directive", new RegExp(j("\\bv-", "html\\b"))],
  ["svelte-at-html", new RegExp(j("\\{@", "html\\b"))],
  ["template-safe-filter", new RegExp(j("\\|\\s*", "safe\\b"))],
  ["handlebars-triple", new RegExp(j("\\{\\{", "\\{"))],
  ["angular-inner-html", new RegExp(j("\\[inner", "HTML\\]"), "i")],
  ["iframe-srcdoc", new RegExp(j("\\bsrc", "doc\\s*="), "i")],
  ["jquery-html", new RegExp(j("\\.\\s*html\\s*\\(\\s*[^)\\s]"))],
];
const SCANNED = /\.(?:m?js|cjs|ts|mts|cts|tsx|jsx|vue|svelte|html?|xhtml|svg|hbs|handlebars|njk|jinja2?|j2|ejs)$/i;

// Scans src/ and public/ of the app at `root`; returns [{ file, line, sink }] for every match.
// Comments and strings are scanned too: a false positive is cheap, a missed sink is not.
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
      const lines = readFileSync(p, "utf8").split("\n");
      lines.forEach((text, i) => {
        for (const [sink, re] of SINKS) if (re.test(text)) hits.push({ file: relative(root, p).split(sep).join("/"), line: i + 1, sink });
      });
    }
  };
  for (const d of dirs) walk(join(root, d));
  return hits;
}
