// SM-04 add-on: outbound resilience (docs/modules/S3.md, "S3-b4 SM-04 build notes").
// SM-04-L1: every outbound call has an explicit timeout, and a hanging dependency fails within it.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { safeFetch } from "./safe-fetch.mjs";

export const MAX_TIMEOUT_MS = 120_000;

export class OutboundTimeout extends Error {
  constructor(name, ms) { super(`${name}: no answer within ${ms} ms`); this.name = "OutboundTimeout"; this.code = "timeout"; this.dependency = name; this.timeoutMs = ms; }
}

function checkTimeout(ms, where) {
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_TIMEOUT_MS) throw new TypeError(`${where}: timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
  return ms;
}
function checkName(name, where) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new TypeError(`${where}: name must be a short lower-case dependency name`);
  return name;
}

// withDeadline(name, timeoutMs, (signal) => work): for an outbound call that is not HTTP (a database query, a queue,
// an SDK). The work gets an AbortSignal that fires at the deadline; the promise rejects with OutboundTimeout then,
// even if the work ignores the signal. There is no default: the caller states the timeout.
export function withDeadline(name, timeoutMs, work) {
  checkName(name, "withDeadline"); checkTimeout(timeoutMs, "withDeadline");
  if (typeof work !== "function") throw new TypeError("withDeadline: work must be a function of the abort signal");
  const ac = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { const e = new OutboundTimeout(name, timeoutMs); ac.abort(e); reject(e); }, timeoutMs);
  });
  let run;
  try { run = Promise.resolve(work(ac.signal)); } catch (e) { clearTimeout(timer); return Promise.reject(e); }
  run.catch(() => {}); // a late failure after the deadline is not an unhandled rejection
  return Promise.race([run, deadline]).finally(() => clearTimeout(timer));
}

// outbound({ name, baseUrl, timeoutMs, ...safeFetch options }): one client per external dependency. Every call goes
// through the F2 fetch with the client's timeout; a call may lower it but never drop or raise it past the client's.
export function outbound({ name, baseUrl, timeoutMs, ...defaults } = {}) {
  checkName(name, "outbound"); checkTimeout(timeoutMs, "outbound");
  let base;
  try { base = new URL(baseUrl); } catch { throw new TypeError("outbound: baseUrl must be an absolute URL"); }
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new TypeError("outbound: baseUrl must be http(s)");
  const call = async (path, opts = {}) => {
    const ms = opts.timeoutMs === undefined ? timeoutMs : checkTimeout(opts.timeoutMs, `${name}.call`);
    if (ms > timeoutMs) throw new TypeError(`${name}.call: timeoutMs may not exceed the client's ${timeoutMs} ms`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) throw new TypeError(`${name}.call: the path must stay on ${base.origin}`);
    try {
      return await safeFetch(url.href, { ...defaults, ...opts, timeoutMs: ms });
    } catch (e) {
      if (e && e.code === "timeout") throw new OutboundTimeout(name, ms);
      throw e;
    }
  };
  return Object.freeze({ name, timeoutMs, call });
}

// ---------- untimed-call check ----------
// Code view: comments blanked and string/template text blanked (quotes, offsets and ${…} expressions kept), so
// words and parentheses inside comments and strings neither hide nor fake a call. A "/" where an expression can
// start (after an operator, "(", ",", "=", a keyword such as return, or at the start) begins a regex literal, whose
// body (with its character classes) is blanked like a string.
export function codeView(src) {
  const out = src.split("");
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== "\n") out[k] = " "; };
  const stack = []; // open template literals: brace depth at which each ${ started
  let depth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? src.length : e; blank(i, end); i = end - 1; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end - 1; continue; }
    if (c === "/" && regexCanStart(out, i)) {
      let k = i + 1, cls = false;
      for (; k < src.length && src[k] !== "\n"; k++) {
        if (src[k] === "\\") { k++; continue; }
        if (src[k] === "[") cls = true; else if (src[k] === "]") cls = false; else if (src[k] === "/" && !cls) break;
      }
      blank(i + 1, k); i = k; continue;
    }
    if (c === '"' || c === "'") {
      let k = i + 1;
      for (; k < src.length && src[k] !== c && src[k] !== "\n"; k++) if (src[k] === "\\") k++;
      blank(i + 1, k); i = k; continue;
    }
    if (c === "`" || (c === "}" && stack.length && stack[stack.length - 1] === depth)) {
      if (c === "}") stack.pop();
      let k = i + 1;
      for (; k < src.length && src[k] !== "`" && !(src[k] === "$" && src[k + 1] === "{"); k++) if (src[k] === "\\") k++;
      blank(i + 1, k);
      if (src[k] === "$") { stack.push(depth); i = k + 1; } else i = k;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return out.join("");
}

function regexCanStart(out, i) {
  let k = i - 1;
  while (k >= 0 && /\s/.test(out[k])) k--;
  if (k < 0) return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(out[k])) return true;
  const word = /[A-Za-z_$][\w$]*$/.exec(out.slice(Math.max(0, k - 12), k + 1))?.[0];
  return ["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"].includes(word);
}

// Splits the text after an opening "(" into top-level arguments; returns { args, end } or null if never closed.
function topLevelArgs(code, start) {
  const args = [], spans = []; let depth = 0, from = start;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (depth === 0) { if (code.slice(from, i).trim()) { args.push(code.slice(from, i)); spans.push([from, i]); } return { args, spans, end: i }; }
      depth--;
    } else if (c === "," && depth === 0) { args.push(code.slice(from, i)); spans.push([from, i]); from = i + 1; }
  }
  return null;
}

// Why an options argument does not give an explicit, bounded timeout, or "" when it does.
// `arg` is the code view of the options argument and `rawArg` the same span of the source (for quoted keys).
function timeoutProblem(arg, rawArg = arg) {
  const t = arg?.trim();
  if (!t) return "no options argument with timeoutMs";
  const obj = t.replace(/\s+as\s+const$/, "").replace(/\s+satisfies\s+[\w$.<>]+$/, "");
  if (!obj.startsWith("{") || !obj.endsWith("}")) return "options must be an object literal that names timeoutMs";
  const lead = arg.length - arg.trimStart().length;
  const rawObj = rawArg.slice(lead, lead + obj.length);
  const parsed = topLevelArgs(obj.slice(1, -1) + ")", 0);
  const props = (parsed?.spans ?? []).map(([a, b]) => ({ code: obj.slice(1 + a, 1 + b).trim(), raw: rawObj.slice(1 + a, 1 + b).trim() })).filter((x) => x.code);
  const isTimeout = (x) => /^timeoutMs\s*(?::|$)/.test(x.code) || (/^(["'])timeoutMs\1\s*:/.test(x.raw) && /^(["'])\s*\1\s*:/.test(x.code));
  const last = props.findLastIndex(isTimeout);
  if (last < 0) return "the options do not name timeoutMs";
  // A spread after the timeout can override it (…opts may carry timeoutMs: undefined), so it is refused.
  if (props.slice(last + 1).some((x) => x.code.startsWith("..."))) return "a spread after timeoutMs can override it";
  const prop = props[last].code;
  const value = prop.includes(":") ? prop.slice(prop.indexOf(":") + 1).trim() : "timeoutMs";
  if (/^(?:undefined|null|void\b.*)$/.test(value)) return "timeoutMs is not set";
  if (/^[+-]?(?:0[xob][\da-f_]+|[\d_.]+(?:e[+-]?\d+)?)n?$/i.test(value)) {
    const n = Number(value.replaceAll("_", "").replace(/n$/, ""));
    if (!(n >= 1 && n <= MAX_TIMEOUT_MS)) return `timeoutMs must be from 1 to ${MAX_TIMEOUT_MS}`;
  }
  return "";
}

// findUntimedCalls(root): every use of the F2 fetch in src/ that is not a direct call with an explicit, bounded
// timeoutMs in an object-literal options argument (shorthand allowed). The fetch's own 10 s default is a fallback,
// not an explicit timeout. Inverse rules, as for F2-1: any other use of the name (an alias, a value, ?.(), .call,
// a spread of the arguments) is reported, and so is any reference to the module other than the plain named import.
// Calls through outbound() always carry a timeout. Returns [{ file, line, reason }].
export function findUntimedCalls(root, dirs = ["src"]) {
  const hits = [];
  const name = ["safe", "Fetch"].join("");
  const mod = ["safe", "fetch"].join("-");
  // Named imports without a rename, from a relative path to the module, optionally followed by a line comment.
  const plainImport = new RegExp(`^[ \\t]*import\\s*\\{(?:\\s*[\\w$]+\\s*,)*\\s*${name}\\s*(?:,\\s*[\\w$]+\\s*)*,?\\s*\\}\\s*from\\s*(["'])(?:\\.{1,2}/)+(?:[\\w-]+/)*${mod}\\.mjs\\1\\s*;?[ \\t]*(?://[^\\n]*)?$`, "gm");
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names.sort()) {
      if (["node_modules", ".git", "dist", "build", "vendor"].includes(n)) continue;
      const p = join(dir, n);
      const st = statSync(p);
      if (st.isDirectory()) { walk(p); continue; }
      if (!/\.(?:m?js|cjs|ts|mts|cts|tsx|jsx)$/.test(n)) continue;
      const file = relative(root, p).split(sep).join("/");
      if (file === `src/${mod}.mjs`) continue; // the definition itself
      const raw = readFileSync(p, "utf8");
      const lineOf = (i) => raw.slice(0, i).split("\n").length;
      const hit = (i, reason) => hits.push({ file, line: lineOf(i), reason });
      // The plain named import is the one allowed reference to the module; it is blanked before the scans below.
      const allowed = raw.replace(plainImport, (m) => " ".repeat(m.length));
      for (const m of allowed.matchAll(new RegExp(`${mod}(?:\\.mjs)?\\b`, "g"))) hit(m.index, "the fetch module may only be imported as { " + name + " }");
      const code = codeView(allowed);
      for (const m of code.matchAll(new RegExp(`(?<![\\w$.])${name}(?![\\w$])`, "g"))) {
        const after = /^\s*\(/.exec(code.slice(m.index + name.length));
        if (!after) { hit(m.index, "used other than as a direct call"); continue; }
        const parsed = topLevelArgs(code, m.index + name.length + after[0].length);
        if (!parsed) { hit(m.index, "call is not closed"); continue; }
        if (parsed.args.some((x) => x.trim().startsWith("..."))) { hit(m.index, "arguments must not be spread"); continue; }
        const span = parsed.spans[1];
        const problem = timeoutProblem(parsed.args[1], span ? raw.slice(span[0], span[1]) : undefined);
        if (problem) hit(m.index, problem);
      }
    }
  };
  for (const d of dirs) walk(join(root, d));
  return hits;
}
