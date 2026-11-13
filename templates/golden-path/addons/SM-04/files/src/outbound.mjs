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

// findUntimedCalls(root): calls of the F2 fetch in src/ whose arguments do not name timeoutMs (its own default
// is a fallback, not an explicit timeout). Returns [{ file, line }]. Calls through outbound() always carry one.
// Arguments are read up to the matching parenthesis, so a call split over lines is judged whole. A call whose
// options come from a variable is reported too: the timeout must be visible at the call.
export function findUntimedCalls(root, dirs = ["src"]) {
  const hits = [];
  const callee = ["safe", "Fetch"].join("");
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
      if (file === "src/safe-fetch.mjs") continue; // the definition itself
      const text = readFileSync(p, "utf8");
      const re = new RegExp(`\\b${callee}\\s*\\(`, "g");
      for (const m of text.matchAll(re)) {
        let depth = 1, i = m.index + m[0].length;
        for (; i < text.length && depth > 0; i++) { if (text[i] === "(") depth++; else if (text[i] === ")") depth--; }
        const args = text.slice(m.index + m[0].length, i - 1);
        if (!/\btimeoutMs\s*:/.test(args)) hits.push({ file, line: text.slice(0, m.index).split("\n").length });
      }
    }
  };
  for (const d of dirs) walk(join(root, d));
  return hits;
}
