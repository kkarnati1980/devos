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
const NET_MODULE = /(\bfrom|\bimport|\brequire)\s*\(?\s*["'`](node:)?(https?|http2|net|tls|dgram)["'`]/;
const RAW_CLIENT = [
  [/\bfetch\s*\(/, "fetch("],
  [/["'`](axios|undici|got|node-fetch|superagent|needle|ky|cross-fetch|isomorphic-fetch|ws)["'`]/, "HTTP client package"],
  [/\bnew\s+(XMLHttpRequest|WebSocket|EventSource)\s*\(/, "XMLHttpRequest/WebSocket/EventSource"],
  [/^\s*(import|from)\s+(requests|httpx|urllib3?|aiohttp|http\.client|socket)\b/m, "Python HTTP client"],
  [/\bglobalThis\s*(\.\s*fetch\b|\[)/, "globalThis.fetch"],
  [/(\bfrom|\bimport|\brequire)\s*\(?\s*["'`](node:)?(module|child_process|worker_threads)["'`]/, "module loader / child process (can reach the network indirectly)"],
  [/\bimport\s*\(\s*[^"'`\s)]/, "dynamic import of a computed module name"],
  // A template literal with an interpolation is computed too (Codex PR32-r1): import(`node:${name}`).
  [/\b(import|require)\s*\(\s*`[^`]*\$\{/, "dynamic import of a computed module name"],
  [/\brequire\s*\(\s*[^"'`\s)]/, "require of a computed module name"],
];
// src/server.mjs may take only the server side of node:http: a default/namespace import or { createServer }.
const SERVER_HTTP_OK = /^import\s+(\w+|\*\s+as\s+\w+|\{\s*createServer\s*\})\s+from\s+["'](node:)?http["'];?\s*$/;
const SECRET_SHAPE = /(SECRET|TOKEN|KEY|PASSWORD|PASSWD|PRIVATE|CREDENTIAL)/i;
const CODE = /\.(m?js|cjs|ts|tsx|jsx|py)$/;

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
  for (const f of files.filter((x) => CODE.test(x))) {
    const posix = f.split(path.sep).join("/");
    const isTest = posix.startsWith("test/");   // only the root test/ folder may use fetch against local stubs
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    // F2 is server-side: browser code under public/ talks to its own origin and is covered by F1-4.
    if (posix !== "src/safe-fetch.mjs" && !isTest && !posix.startsWith("public/")) {
      for (const [re, what] of RAW_CLIENT) if (re.test(src)) fails.push(`FAIL F2-1 ${posix}: raw HTTP client (${what}) outside src/safe-fetch.mjs`);
      const serving = posix === "src/server.mjs";
      const lines = src.split("\n");
      let binding = null;
      for (const line of lines) {
        const mm = line.match(NET_MODULE);
        if (!mm) continue;
        if (serving && mm[3] === "http" && SERVER_HTTP_OK.test(line.trim())) {
          const b = line.match(/^\s*import\s+(?:\*\s+as\s+)?(\w+)\s+from/); if (b) binding = b[1];
          continue;
        }
        fails.push(`FAIL F2-1 ${posix}: imports node:${mm[3]} outside src/safe-fetch.mjs`);
      }
      // The serving binding may only be used as `<binding>.createServer|STATUS_CODES|METHODS` (Codex PR32-r1):
      // any other use of the bare binding (an alias `const c = http`, destructuring `const { request } = http`,
      // passing it to a function, computed access) is a finding, so the client half can never escape.
      if (binding) {
        // Comments, plain string literals and template literals without interpolation are blanked first, so a URL
        // string like "http://…" is not a use; an interpolated template literal is kept and checked.
        const body = lines.filter((l) => !(l.match(NET_MODULE) && SERVER_HTTP_OK.test(l.trim()))).join("\n")
          .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\$])*`/g, (x) => " ".repeat(x.length));
        for (const u of body.matchAll(new RegExp(`(^|[^.\\w$])${binding}(?![\\w$])`, "g"))) {
          const after = body.slice(u.index + u[0].length);
          const ok = after.match(/^\s*\.\s*(createServer|STATUS_CODES|METHODS)(?![\w$])/);
          if (!ok) { fails.push(`FAIL F2-1 ${posix}: node:http used for more than serving (${binding}${after.slice(0, 20).split("\n")[0]})`); break; }
        }
      }
    }
    if (posix.startsWith("public/") && /process\.env/.test(src)) fails.push(`FAIL F1-4 ${posix}: client code reads process.env`);
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
      if (!(svc.cpus || lim.cpus)) fails.push(`FAIL F3-2 ${f}: service ${name} has no CPU limit`);
      if (!(svc.mem_limit || lim.memory)) fails.push(`FAIL F3-2 ${f}: service ${name} has no memory limit`);
      if (!(svc.pids_limit || lim.pids)) fails.push(`FAIL F3-2 ${f}: service ${name} has no pid limit`);
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
