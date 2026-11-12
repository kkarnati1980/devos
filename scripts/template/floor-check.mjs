#!/usr/bin/env node
// Static floor checks for a repo generated from the golden-path template (S3, docs/modules/S3.md):
//   F2-1  no raw HTTP client outside src/safe-fetch.mjs
//   F1-4  no process.env under public/; no secret-shaped name in CLIENT_CONFIG_KEYS
//   F3-2  every Compose service declares cpus, mem_limit and pids_limit (static half; S4 probes the host)
// The scanning checks (F1-1..F1-3) are gitleaks in CI and S6; F3-1 is S4's probe.
// Usage: floor-check.mjs <repo-dir>  -> exit 0 when clean, 1 with one "FAIL <check> <file>: <why>" line per finding.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

// F2-1 patterns. Network modules are matched by import/require of the module itself (named, namespace,
// default, dynamic or require), so aliases cannot slip through; only src/safe-fetch.mjs may import them, and
// src/server.mjs may import node:http to serve (never its client calls).
// G is the gap between tokens: whitespace or comments (Codex PR32-r4), matched even where a comment was not
// blanked (e.g. after an odd regex literal confused the string scanner).
const G = String.raw`(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*)*`;
const NET_MODULE = new RegExp(String.raw`(\bfrom|\bimport|\brequire)${G}\(?${G}["'\`](node:)?(https?|http2|net|tls|dgram)["'\`]`);
const RAW_CLIENT = [
  [new RegExp(String.raw`\bfetch${G}\(`), "fetch("],
  [/["'`](axios|undici|got|node-fetch|superagent|needle|ky|cross-fetch|isomorphic-fetch|ws)(\/[^"'`\n]*)?["'`]/, "HTTP client package"],
  [/\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\s*\(/, "XMLHttpRequest/WebSocket/EventSource"],
  [/^\s*(import|from)\s+(requests|httpx|urllib3?|aiohttp|http\.client|socket)\b/m, "Python HTTP client"],
  [/\b(globalThis|global|self|window)\s*(\.\s*(fetch|WebSocket|EventSource|XMLHttpRequest)\b|\[)/, "globalThis.fetch"],
  [new RegExp(String.raw`(\bfrom|\bimport|\brequire)${G}\(?${G}["'\`](node:)?(module|child_process|worker_threads|vm|wasi)["'\`]`), "module loader / child process (can reach the network indirectly)"],
];
// Codex PR32-r5: every import(…) / require(…) must name ONE plain string literal and nothing else (an
// expression that starts with a quote, `import("node:" + "http")`, is computed too). Anything else is a finding.
const LOAD_CALL = new RegExp(String.raw`\b(import|require)${G}\(`, "g");
const LITERAL_ARG = new RegExp(String.raw`^${G}(?:"[^"\\\n]*"|'[^'\\\n]*'|\`[^\`\\$]*\`)${G}[,)]`);
function computedLoad(src) {
  for (const m of src.matchAll(LOAD_CALL)) if (!LITERAL_ARG.test(src.slice(m.index + m[0].length))) return m[1];
  return null;
}
// src/server.mjs may take only the server side of node:http: a default/namespace import or { createServer }.
const SERVER_HTTP_OK = /^import\s+(\w+|\*\s+as\s+\w+|\{\s*createServer\s*\})\s+from\s+["'](node:)?http["'];?\s*$/;
const SECRET_SHAPE = /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)/i;
const CODE = /\.(m?js|cjs|m?ts|cts|tsx|jsx|py)$/;
const MARKUP = /\.(html?|xhtml|svg)$/i;
// Codex PR32-r12: the browser decodes character references in attribute values before it runs them as code, so
// handler and javascript: values are decoded first. Named references outside this table are left as they are; the
// raw-text F1-4 rule below does not depend on this table (decision v0.1.12 in docs/modules/S3.md).
const NAMED_REFS = { quot: '"', apos: "'", amp: "&", lt: "<", gt: ">", period: ".", lsqb: "[", lbrack: "[", rsqb: "]",
  rbrack: "]", sol: "/", ast: "*", midast: "*", colon: ":", semi: ";", comma: ",", lpar: "(", rpar: ")", equals: "=",
  quest: "?", grave: "`", bsol: "\\", dollar: "$", Tab: "\t", NewLine: "\n", nbsp: " " };
export function decodeEntities(v) {
  return v.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([A-Za-z][A-Za-z0-9]*));?/g, (x, hex, dec, name) => {
    if (name !== undefined) return Object.hasOwn(NAMED_REFS, name) ? NAMED_REFS[name] : x;
    const cp = parseInt(hex ?? dec, hex !== undefined ? 16 : 10);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : x;
  });
}
/** The browser code inside markup: <script> bodies and on…="…" handler values, each on its own line. */
export function inlineScripts(html) {
  const parts = [];
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)) parts.push(m[1]);
  for (const m of html.matchAll(/\son[a-z]+\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi)) parts.push(decodeEntities(m[2] ?? m[3] ?? m[4]));
  // Codex PR32-r11: the value runs to its own closing delimiter, so a quote of the other kind inside it does not end it.
  for (const m of html.matchAll(/(?:href|src|action|formaction|xlink:href)\s*=\s*(?:"\s*javascript:([^"]*)"|'\s*javascript:([^']*)'|javascript:([^\s>]*))/gi))
    parts.push(decodeEntities(m[1] ?? m[2] ?? m[3]));
  return parts.join("\n;\n");
}
// F1-4 raw-text rule (decision v0.1.12): every markup file under public/ is also scanned as plain text, with no extraction
// and no comment or string blanking, so no parser is left to have a bypass. A `process` word followed by a property
// access (`.`, `?.` or `[`, with only whitespace or comments between) is a finding. Each file is checked as written,
// with character references decoded, and with JS \u escapes decoded; a hit in any view counts.
const RAW_PROCESS = /(^|[^.\w$])process(?![\w$])(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->)*(?:\?\.|\.|\[)/;
const jsUnescape = (v) => v.replace(/\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})/g, (x, a, b) => {
  const cp = parseInt(a ?? b, 16);
  return cp <= 0x10ffff ? String.fromCodePoint(cp) : x;
});
export function rawProcessAccess(text) {
  const decoded = decodeEntities(text);
  return [text, decoded, jsUnescape(text), jsUnescape(decoded)].some((v) => RAW_PROCESS.test(v));
}

// Codex PR32-r4: comments are blanked before F2-1 matching (string literals are kept, newlines and offsets are
// preserved), so `import { request } from /* client */ "node:https"` is still an import of node:https.
const STRING_OR_COMMENT = /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g;
export function blankComments(src) {
  return src.replace(STRING_OR_COMMENT, (x, str) => (str !== undefined ? x : x.replace(/[^\n]/g, " ")));
}
// Codex PR32-r8 / runner pre-review: the code-only view blanks comments AND plain strings (an interpolated template
// literal is kept), so identifier rules see only code. Matching shapes like `fetch(` lost to `(0, fetch)(u)`,
// `fetch?.(u)`, a tagged template or `const { fetch: get } = globalThis`; any bare use of these names is a finding.
export function codeOnly(src) {
  return src.replace(STRING_OR_COMMENT, (x, str) => (str !== undefined && x[0] === "`" && x.includes("${") ? x : x.replace(/[^\n]/g, " ")));
}
const BARE = (names) => new RegExp(String.raw`(^|[^.\w$])(${names})(?![\w$])`);
const CLIENT_IDENT = BARE("fetch|WebSocket|EventSource|XMLHttpRequest");
// Built-in module access that is not an import: process.getBuiltinModule (Node 22), process.binding/_linkedBinding.
const BUILTIN_ACCESS = /\b(getBuiltinModule|_linkedBinding)\b|\bprocess\s*\.\s*binding\b/;
// `require` used as a value (`const r = require`, `require.call(…)`) instead of called with one literal.
// Run-time code generation can rebuild any of the above from strings, so it is a finding outside safe-fetch.
const DYNAMIC_CODE = BARE("eval|Function|WebAssembly");
const REQUIRE_VALUE = new RegExp(String.raw`(^|[^.\w$])require(?![\w$])(?!\s*\()`);

// Codex PR32-r4: a limit counts only when it actually limits. Compose reads `pids_limit: -1` (and 0) as
// unlimited and `cpus: "0"` as no CPU limit, so each value must parse as a positive number.
const POS_NUMBER = /^\s*(\d+(\.\d+)?|\.\d+)\s*$/;
const MEM_SIZE = /^\s*(\d+(\.\d+)?)\s*([bkmgt]i?b?)?\s*$/i;
const PIDS = /^\s*\d+\s*$/;
function positive(v, re) {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 && (re !== PIDS || Number.isInteger(v));
  if (typeof v !== "string") return false;
  const m = v.match(re);
  return !!m && parseFloat(m[1] ?? m[0]) > 0;
}

function walk(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (e.name === ".git" || e.name === "node_modules") continue;
    if (!rel && ["dist", "build", "coverage"].includes(e.name)) continue;   // build output only at the root
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...walk(dir, r)); else out.push(r);
  }
  return out;
}

export function floorCheck(dir) {
  const fails = [];
  const files = walk(dir);
  // Codex PR32-r9: HTML (and SVG) under public/ carries browser code in <script> blocks and on…="" handlers, so
  // those are scanned as client code too; the markup around them is not code.
  const isMarkup = (x) => /^public\//.test(x.split(path.sep).join("/")) && MARKUP.test(x);
  for (const f of files.filter((x) => CODE.test(x) || isMarkup(x))) {
    const posix = f.split(path.sep).join("/");
    const isTest = posix.startsWith("test/");   // only the root test/ folder may use fetch against local stubs
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const raw = MARKUP.test(posix) ? inlineScripts(text) : text;
    const src = /\.py$/.test(posix) ? raw : blankComments(raw);
    const code = /\.py$/.test(posix) ? raw : codeOnly(raw);
    // Browser code under public/ may use fetch against its own origin (F1-4 covers it), but a node: network import,
    // built-in module access or a module loader there is server egress hidden in public/ (runner pre-review).
    if (posix.startsWith("public/") && !/\.py$/.test(posix)) {
      for (const mm of src.matchAll(new RegExp(NET_MODULE.source, "g"))) { fails.push(`FAIL F2-1 ${posix}: imports node:${mm[3]} in browser code`); break; }
      if (BUILTIN_ACCESS.test(code) || REQUIRE_VALUE.test(code) || computedLoad(src) || RAW_CLIENT[5][0].test(src))
        fails.push(`FAIL F2-1 ${posix}: raw HTTP client (module loader or built-in access) in browser code`);
    }
    // F2 is server-side: browser code under public/ talks to its own origin and is covered by F1-4.
    if (posix !== "src/safe-fetch.mjs" && !isTest && !posix.startsWith("public/")) {
      for (const [re, what] of RAW_CLIENT) if (re.test(src)) fails.push(`FAIL F2-1 ${posix}: raw HTTP client (${what}) outside src/safe-fetch.mjs`);
      if (!/\.py$/.test(posix)) {
        if (CLIENT_IDENT.test(code)) fails.push(`FAIL F2-1 ${posix}: raw HTTP client (fetch/WebSocket/EventSource/XMLHttpRequest used) outside src/safe-fetch.mjs`);
        if (BUILTIN_ACCESS.test(code)) fails.push(`FAIL F2-1 ${posix}: raw HTTP client (built-in module access: getBuiltinModule/binding) outside src/safe-fetch.mjs`);
        if (DYNAMIC_CODE.test(code)) fails.push(`FAIL F2-1 ${posix}: raw HTTP client (eval/Function/WebAssembly can build one at run time) outside src/safe-fetch.mjs`);
        if (REQUIRE_VALUE.test(code)) fails.push(`FAIL F2-1 ${posix}: raw HTTP client (require used as a value) outside src/safe-fetch.mjs`);
      }
      const load = computedLoad(src);
      if (load) fails.push(`FAIL F2-1 ${posix}: raw HTTP client (${load === "import" ? "dynamic import" : "require"} of a computed module name) outside src/safe-fetch.mjs`);
      const serving = posix === "src/server.mjs";
      // Codex PR32-r3: matched on the whole source, not line by line, so an import split over lines
      // (`import { request } from\n"node:https"`) is still found (\s in NET_MODULE spans newlines). src/server.mjs
      // gets exactly ONE serving import of node:http, written on one line; any second network-module reference,
      // including a second node:http import under another name, is a finding.
      let binding = null, allowedLine = null;
      for (const mm of src.matchAll(new RegExp(NET_MODULE.source, "g"))) {
        if (serving && mm[3] === "http" && allowedLine === null) {
          const ls = src.lastIndexOf("\n", mm.index) + 1, le = src.indexOf("\n", mm.index);
          const line = src.slice(ls, le < 0 ? undefined : le);
          if (SERVER_HTTP_OK.test(line.trim())) {
            allowedLine = line;
            const b = line.match(/^\s*import\s+(?:\*\s+as\s+)?(\w+)\s+from/); if (b) binding = b[1];
            continue;
          }
        }
        fails.push(`FAIL F2-1 ${posix}: imports node:${mm[3]} outside src/safe-fetch.mjs`);
      }
      // The serving binding may only be used as `<binding>.createServer|STATUS_CODES|METHODS` (Codex PR32-r1):
      // any other use of the bare binding (an alias `const c = http`, destructuring `const { request } = http`,
      // passing it to a function, computed access) is a finding, so the client half can never escape.
      if (binding) {
        // Comments, plain string literals and template literals without interpolation are blanked first, so a URL
        // string like "http://…" is not a use; an interpolated template literal is kept and checked.
        const lines = src.split("\n"); lines.splice(lines.indexOf(allowedLine), 1);   // only the one allowed import
        const body = lines.join("\n")
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\$])*`/g, (x) => " ".repeat(x.length));
        for (const u of body.matchAll(new RegExp(`(^|[^.\\w$])${binding}(?![\\w$])`, "g"))) {
          const after = body.slice(u.index + u[0].length);
          const ok = after.match(/^\s*\.\s*(createServer|STATUS_CODES|METHODS)(?![\w$])/);
          if (!ok) { fails.push(`FAIL F2-1 ${posix}: node:http used for more than serving (${binding}${after.slice(0, 20).split("\n")[0]})`); break; }
        }
      }
    }
    // F1-4 (Codex PR32-r8): browser code has no reason to touch `process` at all, so any use of the identifier is a
    // finding, however it is spelled (`process . env`, `process\n.env`, `const p = process`), once comments and
    // strings are blanked (an interpolated template literal is kept and checked). A string that is exactly "process" is flagged too, for computed access (`globalThis["process"]`).
    if (posix.startsWith("public/")) {
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`/g,
        (x) => (/^(["'`])process\1$/.test(x) ? "process" : x[0] === "`" && x.includes("${") ? x : " ".repeat(x.length)));
      if (/(^|[^.\w$])process(?![\w$])/.test(jsUnescape(code)) || (MARKUP.test(posix) && rawProcessAccess(text))) fails.push(`FAIL F1-4 ${posix}: client code reads process.env`);
    }
    const m = src.match(/CLIENT_CONFIG_KEYS\s*=\s*\[([^\]]*)\]/);
    if (m) for (const k of m[1].match(/["'][^"']+["']/g) || []) if (SECRET_SHAPE.test(k)) fails.push(`FAIL F1-4 ${posix}: secret-shaped client config key ${k}`);
  }
  const composeFiles = files.filter((x) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(x));
  if (!composeFiles.length) fails.push("FAIL F3-2 compose.yaml: missing");
  for (const f of composeFiles) {
    let doc;
    try { doc = parse(fs.readFileSync(path.join(dir, f), "utf8")); } catch (e) { fails.push(`FAIL F3-2 ${f}: not valid YAML`); continue; }
    for (const [name, raw] of Object.entries((doc && doc.services) || {})) {
      const svc = raw && typeof raw === "object" ? raw : {};
      const lim = (svc && svc.deploy && svc.deploy.resources && svc.deploy.resources.limits) || {};
      if (!(positive(svc.cpus, POS_NUMBER) || positive(lim.cpus, POS_NUMBER))) fails.push(`FAIL F3-2 ${f}: service ${name} has no CPU limit`);
      if (!(positive(svc.mem_limit, MEM_SIZE) || positive(lim.memory, MEM_SIZE))) fails.push(`FAIL F3-2 ${f}: service ${name} has no memory limit`);
      if (!(positive(svc.pids_limit, PIDS) || positive(lim.pids, PIDS))) fails.push(`FAIL F3-2 ${f}: service ${name} has no pid limit`);
      if (svc.network_mode === "host") fails.push(`FAIL F3-2 ${f}: service ${name} uses the host network`);
    }
  }
  return fails;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const dir = process.argv[2];
  if (!dir || !fs.existsSync(dir)) { console.error("usage: floor-check.mjs <repo-dir>"); process.exit(2); }
  const fails = floorCheck(dir);
  for (const l of fails) console.log(l);
  console.log(fails.length ? `floor-check: ${fails.length} finding(s)` : "floor-check: F1-4, F2-1, F3-2 pass");
  process.exit(fails.length ? 1 : 0);
}
