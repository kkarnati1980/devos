// S3-a (DEVOS-92): golden-path core, apply tool and static floor checks. Contract: docs/modules/S3.md AT1–AT6.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { apply } from "../template/apply.mjs";
import { floorCheck } from "../template/floor-check.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
let tmp;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devos-template-")); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const fresh = (name, select = []) => { const out = path.join(tmp, name); const r = apply({ out, select, sha: "a".repeat(40) }); assert.equal(r.code, 0, r.error); return out; };
const write = (dir, rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

test("AT1: no selection gives the core only, with a manifest, and the core passes the floor checks", () => {
  const out = fresh("core");
  const m = JSON.parse(fs.readFileSync(path.join(out, ".devos/template.json"), "utf8"));
  assert.deepEqual([m.selected, m.applied, m.pending], [[], [], []]);
  assert.equal(m.devosSha, "a".repeat(40));
  for (const f of ["src/safe-fetch.mjs", "src/config.mjs", "src/server.mjs", "compose.yaml", "Dockerfile", "package.json"]) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.ok(!fs.existsSync(path.join(out, "addons")), "no add-on content");
  assert.deepEqual(floorCheck(out), []);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts/template/floor-check.mjs"), out], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
});

test("AT2/AT4/AT5: the generated core's own tests pass (F2-2 corpus, caps, /health, /ready, logs, F1 client allow-list)", () => {
  const out = fresh("core-tests");
  const r = spawnSync(process.execPath, ["--test", "test/safe-fetch.test.mjs", "test/server.test.mjs"], { cwd: out, encoding: "utf8", timeout: 60_000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== "NODE_TEST_CONTEXT")) });
  assert.equal(r.status, 0, r.stdout.slice(-3000) + r.stderr.slice(-2000));
  assert.match(r.stdout, /# pass 22/);
  assert.match(r.stdout, /# fail 0/);
});

test("AT3: floor-check names F2-1, F1-4 and F3-2 violations", () => {
  const out = fresh("bad");
  write(out, "src/feed.mjs", "export const get = (u) => fetch(u);\n");
  write(out, "src/sock.mjs", 'import { request } from "node:https";\nexport default request;\n');
  write(out, "src/client.mjs", 'import axios from "axios";\nexport default axios;\n');
  write(out, "test/helper.test.mjs", "await fetch('http://localhost');\n");   // tests may use fetch
  write(out, "public/app.js", "const k = process.env.API_KEY;\n");
  write(out, "src/cfg.mjs", 'export const CLIENT_CONFIG_KEYS = ["PUBLIC_NAME", "STRIPE_SECRET_KEY"];\n');
  fs.writeFileSync(path.join(out, "compose.yaml"), "services:\n  app:\n    build: .\n    cpus: '0.5'\n  worker:\n    build: .\n    network_mode: host\n    deploy: { resources: { limits: { cpus: '0.2', memory: 128m, pids: 64 } } }\n");
  const f = floorCheck(out);
  const has = (re) => assert.ok(f.some((l) => re.test(l)), `${re} in\n${f.join("\n")}`);
  has(/^FAIL F2-1 src\/feed\.mjs: .*fetch\(/);
  has(/^FAIL F2-1 src\/sock\.mjs: .*node:http/);
  has(/^FAIL F2-1 src\/client\.mjs: .*package/);
  has(/^FAIL F1-4 public\/app\.js: client code reads process\.env/);
  has(/^FAIL F1-4 src\/cfg\.mjs: secret-shaped client config key "STRIPE_SECRET_KEY"/);
  has(/^FAIL F3-2 compose\.yaml: service app has no memory limit/);
  has(/^FAIL F3-2 compose\.yaml: service app has no pid limit/);
  has(/^FAIL F3-2 compose\.yaml: service worker uses the host network/);
  assert.ok(!f.some((l) => /helper\.test/.test(l)), "test files may use fetch");
  assert.ok(!f.some((l) => /service worker has no/.test(l)), "deploy.resources.limits count as limits");
  assert.ok(!f.some((l) => /^FAIL \S+ src\/(server|safe-fetch|config|log)\.mjs:/.test(l)), "the core itself is clean");
  const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts/template/floor-check.mjs"), out], { encoding: "utf8" });
  assert.equal(cli.status, 1);
});

test("AT3: F2-1 catches aliased, required and socket-level clients anywhere outside the root test/ folder; browser code is F1-4's", () => {
  const out = fresh("bypass");
  const cases = {
    "src/ns.mjs": 'import * as h from "node:http";\nexport const go = (u) => h.request(u);\n',
    "src/req.cjs": 'const { get } = require("https");\nmodule.exports = get;\n',
    "src/sock.mjs": 'import { createConnection } from "node:net";\nexport default createConnection;\n',
    "src/h2.mjs": 'import { connect } from "node:http2";\nexport default connect;\n',
    "src/split.mjs": 'import { request } from\n"node:https";\nrequest("https://example.com");\n',   // Codex PR32-r3
    "src/splitreq.cjs": 'const { get } = require(\n  "node:http"\n);\nget("http://10.0.0.1/");\n',
    "src/dyn.mjs": 'export const m = await import("node:https");\n',
    "src/ws.mjs": "export const ws = (u) => new WebSocket(u);\n",
    "src/build/f.mjs": "export const f = (u) => fetch(u);\n",
    "src/test/g.mjs": "export const g = (u) => fetch(u);\n",
    "src/util.test.mjs": "export const t = (u) => fetch(u);\n",
    "worker/fetch.py": "from requests import get\n",
    "worker/u.py": "import urllib.request\n",
    "src/gt.mjs": "export const f = globalThis.fetch;\n",
    "src/cp.mjs": 'import { execFile } from "node:child_process";\nexport default execFile;\n',
    "src/cr.mjs": 'import { createRequire } from "node:module";\nexport default createRequire;\n',
    "src/dm.mjs": "const m = 'node:' + 'http';\nexport const x = await import(m);\n",
    "src/tl.mjs": "const name = 'http';\nconst c = await import(`node:${name}`);\nexport default c;\n",
    "src/rq.cjs": "const n = 'https';\nmodule.exports = require(n);\n",
    // Codex PR32-r4: comments between the tokens of an import, require or fetch call.
    "src/cm.mjs": 'import { request } from /* client */ "node:https";\nrequest("http://169.254.169.254/").end();\n',
    "src/cl.mjs": 'import { get } from // line comment\n  "node:http";\nget("http://10.0.0.1/");\n',
    "src/cr2.cjs": 'const h = require(/* x */ "node:https");\nmodule.exports = h;\n',
    "src/cf.mjs": 'export const f = (u) => fetch /* x */ (u);\n',
    // Codex PR32-r5: computed names that start with a quote.
    "src/cc.mjs": 'const h = await import("node:" + "http");\nh.get("http://169.254.169.254/");\n',
    "src/cc2.cjs": "const h = require('node:' + 'https');\nmodule.exports = h;\n",
    "src/cc3.mjs": 'const t = "s"; export const m = await import("node:http" + t);\n',
    "src/cc4.mjs": 'export const m = await import(`node:http`.concat("s"));\n',
  };
  for (const [f, c] of Object.entries(cases)) write(out, f, c);
  write(out, "public/app.js", 'fetch("/api/items");\n');
  fs.writeFileSync(path.join(out, "compose.yaml"), "services:\n  app:\n");
  const f = floorCheck(out);
  for (const file of Object.keys(cases)) assert.ok(f.some((l) => l.startsWith(`FAIL F2-1 ${file}:`)), `${file} in\n${f.join("\n")}`);
  assert.ok(!f.some((l) => l.includes("public/app.js")), "same-origin browser fetch is not F2-1");
  assert.ok(f.some((l) => /F3-2 compose\.yaml: service app has no CPU limit/.test(l)), "a null service is a finding, not a crash");
});

test("AT3: F3-2 counts only limits that limit: -1, 0 and \"0\" are findings; positive values pass (Codex PR32-r4)", () => {
  const out = fresh("limits");
  fs.writeFileSync(path.join(out, "compose.yaml"), [
    "services:",
    "  unlimited:", '    cpus: "0"', "    mem_limit: 0", "    pids_limit: -1",
    "  zeros:", "    cpus: 0", '    mem_limit: "0m"', "    pids_limit: 0",
    "  junk:", '    cpus: "lots"', '    mem_limit: "-512m"', '    pids_limit: "1.5"',
    "  deploy-zero:", "    deploy:", "      resources:", "        limits:", '          cpus: "0.0"', '          memory: "0"', "          pids: -1",
    "  good:", '    cpus: "0.5"', '    mem_limit: "512m"', "    pids_limit: 200",
    "  good-deploy:", "    deploy:", "      resources:", "        limits:", "          cpus: 1", "          memory: 268435456", '          pids: "100"',
    "",
  ].join("\n"));
  const f = floorCheck(out).filter((l) => l.includes("F3-2"));
  for (const svc of ["unlimited", "zeros", "junk", "deploy-zero"])
    for (const what of ["CPU", "memory", "pid"]) assert.ok(f.some((l) => l.includes(`service ${svc} has no ${what} limit`)), `${svc} ${what} in\n${f.join("\n")}`);
  assert.ok(!f.some((l) => /service good(-deploy)? /.test(l)), f.join("\n"));
});

test("AT1: comments do not hide imports, and URLs inside strings are not comments (Codex PR32-r4)", () => {
  const out = fresh("comments");
  write(out, "src/ok.mjs", 'export const u = "http://example.com/a//b"; // a "quoted" note\n/* import x from "node:https" is only text here */\n');
  // A plain literal dynamic import or require (with import attributes) is not computed.
  write(out, "src/lit.mjs", 'export const a = await import("./ok.mjs");\nexport const b = await import(\'./data.json\', { with: { type: "json" } });\n');
  write(out, "src/data.json", "{}\n");
  assert.deepEqual(floorCheck(out), []);
});

test("AT6: a trailing slash stages beside the output; the CLIs work from a path with a space", () => {
  const out = path.join(tmp, "slash") + path.sep;
  assert.equal(apply({ out, select: [] }).code, 0);
  assert.ok(fs.existsSync(path.join(out, ".devos/template.json")));
  assert.ok(!fs.readdirSync(out).some((n) => n.includes("partial")));
  const spaced = path.join(tmp, "with space");
  fs.mkdirSync(path.join(spaced, "scripts"), { recursive: true });
  fs.cpSync(path.join(ROOT, "scripts/template"), path.join(spaced, "scripts/template"), { recursive: true });
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(spaced, "node_modules"));
  const bad = spawnSync(process.execPath, [path.join(spaced, "scripts/template/floor-check.mjs"), path.join(tmp, "nope")], { encoding: "utf8" });
  assert.equal(bad.status, 2, "a missing directory is an error, never a silent pass: " + bad.stderr);
  const m = JSON.parse(fs.readFileSync(path.join(out, ".devos/template.json"), "utf8"));
  assert.match(m.devosSha, /^[0-9a-f]{40}$/, "the DevOS SHA is recorded by default");
});

test("AT4/AT6: the generated server starts with `node src/server.mjs` from a path with a space and answers /health (Codex PR32-r6)", async () => {
  const out = path.join(tmp, "my app");
  assert.equal(apply({ out, select: [], sha: "b".repeat(40) }).code, 0);
  const { spawn } = await import("node:child_process");
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["src/server.mjs"], { cwd: out, env: { PATH: process.env.PATH, PORT: String(port), HOST: "127.0.0.1" }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let body = null;
    for (let i = 0; i < 50 && body === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.status === 200) body = await r.json(); } catch { /* not up yet */ }
    }
    assert.ok(body, "the server never answered /health");
  } finally { child.kill(); }
});

test("AT6: apply refuses unknown, floor or opt-in IDs and a non-empty output, writing nothing; a module with no add-on is pending", () => {
  for (const sel of [["SM-99"], ["F2"], ["SM-C3"], ["SM-01", "bogus"]]) {
    const out = path.join(tmp, `refused-${sel.join("-")}`);
    const r = apply({ out, select: sel });
    assert.equal(r.code, 2); assert.match(r.error, /not a selectable module/);
    assert.ok(!fs.existsSync(out), "nothing written");
  }
  const busy = path.join(tmp, "busy"); fs.mkdirSync(busy); fs.writeFileSync(path.join(busy, "keep.txt"), "mine");
  const r = apply({ out: busy, select: [] });
  assert.equal(r.code, 2); assert.match(r.error, /not empty/);
  assert.deepEqual(fs.readdirSync(busy), ["keep.txt"]);
  assert.ok(!fs.readdirSync(tmp).some((n) => n.includes(".partial-")), "no staging left behind");
  const out = fresh("pending", ["SM-09", "SM-15"]);
  const m = JSON.parse(fs.readFileSync(path.join(out, ".devos/template.json"), "utf8"));
  assert.deepEqual(m.selected, ["SM-09", "SM-15"]); assert.deepEqual(m.pending, ["SM-09", "SM-15"]); assert.deepEqual(m.applied, []);
  const cli = spawnSync(process.execPath, [path.join(ROOT, "scripts/template/apply.mjs"), "--out", path.join(tmp, "cli"), "--select", "SM-99"], { encoding: "utf8" });
  assert.equal(cli.status, 2); assert.match(cli.stderr, /refused/); assert.ok(!fs.existsSync(path.join(tmp, "cli")));
});

test("the template ships no add-on yet, and no secret or env file", () => {
  const addons = path.join(ROOT, "templates/golden-path/addons");
  assert.deepEqual(fs.readdirSync(addons).filter((n) => n !== ".gitkeep"), []);
  const core = execFileSync("git", ["ls-files", "templates/golden-path"], { cwd: ROOT, encoding: "utf8" });
  assert.ok(!/\.env(\.|$)/m.test(core));
});

test("AT3: src/server.mjs may serve with node:http but never use its client side", () => {
  const ok = fresh("server-ok");
  write(ok, "src/server.mjs", fs.readFileSync(path.join(ok, "src/server.mjs"), "utf8") + "\nconst cache = new Map(); cache.get('k'); new URL('http://x').searchParams.get('a');\n");
  assert.deepEqual(floorCheck(ok), [], "Map.get and searchParams.get are not HTTP calls");
  for (const [name, code] of Object.entries({
    alias: 'import http, { request as r } from "node:http";\nexport const leak = (u) => r(u);\n',
    named: 'import { get } from "node:http";\nexport default get;\n',
    bracket: 'import http from "node:http";\nexport const leak = (u) => http["request"](u);\n',
    dot: 'import http from "node:http";\nexport const leak = (u) => http.get(u);\n',
    https: 'import https from "node:https";\nexport default https;\n',
    bareAlias: 'import http from "node:http";\nconst client = http;\nexport const leak = (u) => client.request(u);\n',
    destructure: 'import http from "node:http";\nconst { request } = http;\nexport default request;\n',
    passed: 'import http from "node:http";\nexport const leak = (f) => f(http);\n',
    interpolated: 'import http from "node:http";\nexport const leak = (u) => `${http.request(u)}`;\n',
    // Codex PR32-r3: a second node:http import under another name, and imports split over lines
    secondImport: 'import client from "node:http";\nimport http from "node:http";\nhttp.createServer(() => {});\nclient.request("http://169.254.169.254/").end();\n',
    multilineNamed: 'import http from "node:http";\nimport { request } from\n"node:https";\nrequest("https://example.com");\n',
    multilineDefault: 'import client from\n  "node:http";\nclient.request("http://10.0.0.1/");\n',
  })) {
    const out = fresh(`server-${name}`);
    write(out, "src/server.mjs", code);
    assert.ok(floorCheck(out).some((l) => l.startsWith("FAIL F2-1 src/server.mjs:")), name);
  }
});

test("Codex PR32-r8: F1-4 flags any use of process in browser code, however it is spelled; comments and plain strings are not uses", () => {
  const out = fresh("f14");
  const bad = {
    "public/a.js": "const token = process . env.API_TOKEN;\n",
    "public/b.js": "const t = process\n  .env.API_TOKEN;\n",
    "public/c.js": "const p = process; export const t = p.env.X;\n",
    "public/d.js": 'export const t = globalThis["process"].env.X;\n',
    "public/e.js": "export const t = `${process.env.X}`;\n",
    "public/f.js": "const t = process/* gap */.env.X;\n",
  };
  const good = { "public/ok.js": '// process.env is not read here\nconst label = "process.env"; job.process(); export { label };\n' };
  for (const [f, src] of Object.entries({ ...bad, ...good })) write(out, f, src);
  const f = floorCheck(out);
  for (const name of Object.keys(bad)) assert.ok(f.some((l) => l.startsWith(`FAIL F1-4 ${name}:`)), `${name} in\n${f.join("\n")}`);
  assert.ok(!f.some((l) => l.includes("public/ok.js")), f.join("\n"));
});

test("runner pre-review: F2-1 catches built-in access, bare client identifiers, require as a value, .mts/.cts, package subpaths and node: imports in public/", () => {
  const out = fresh("f21b");
  const bad = {
    "src/a.mjs": 'const h = process.getBuiltinModule("node:https"); h.get("https://169.254.169.254/");\n',
    "src/a2.mjs": 'const b = process . binding("tcp_wrap"); export default b;\n',
    "public/net.mjs": 'import https from "node:https";\nexport default https;\n',
    "src/b1.mjs": "const { fetch: get } = globalThis; export const x = (u) => get(u);\n",
    "src/b2.mjs": "export const x = (u) => (0, fetch)(u);\n",
    "src/b3.mjs": "export const x = (u) => fetch?.(u);\n",
    "src/b4.mjs": "export const x = () => fetch`http://10.0.0.1/`;\n",
    "src/b5.mjs": "const W = WebSocket; export const x = (u) => new W(u);\n",
    "src/d.cjs": 'const r = require; module.exports = r("node:https");\n',
    "src/d2.cjs": 'module.exports = require.call(null, "node:https");\n',
    "src/e.mts": 'export const x = (u: string) => fetch(u);\n',
    "src/e2.cts": 'export const x = (u: string) => fetch(u);\n',
    "src/f.mjs": 'import { request } from "undici/index.js";\nexport default request;\n',
    "src/g.mjs": "const f = global.fetch; export const x = (u) => f(u);\n",
    "src/h.mjs": 'export const x = (s) => eval(s);\n',
    "src/h2.mjs": 'export const x = new Function("u", "return u");\n',
    "src/h3.mjs": 'import vm from "node:vm";\nexport default vm;\n',
  };
  const good = { "src/ok.mjs": '// fetch(u) is not called here\nconst label = "fetch"; export const run = (job) => job.go(label);\n' };
  for (const [f, src] of Object.entries({ ...bad, ...good })) write(out, f, src);
  const f = floorCheck(out);
  for (const name of Object.keys(bad)) assert.ok(f.some((l) => l.startsWith(`FAIL F2-1 ${name}:`)), `${name} in\n${f.join("\n")}`);
  assert.ok(!f.some((l) => l.includes("src/ok.mjs")), f.join("\n"));
  assert.ok(!f.some((l) => /^FAIL \S+ (src\/(server|safe-fetch|config|log)\.mjs|public\/)/.test(l) && !Object.keys(bad).some((b) => l.includes(b))), "the core itself stays clean");
});

test("Codex PR32-r9: browser code inline in public/ HTML is scanned for F1-4; markup text is not code", () => {
  const out = fresh("f14html");
  write(out, "public/a.html", "<!doctype html><p>Hello</p><script>const token = process.env.API_TOKEN;</script>\n");
  write(out, "public/b.htm", '<button onclick="alert(process.env.X)">x</button>\n');
  write(out, "public/c.html", "<SCRIPT type=module>\n  const t = process\n  .env.X;\n</SCRIPT>\n");
  write(out, "public/d.html", `<a href="javascript:console.log('hello');alert(process.env.API_TOKEN)">go</a>\n`);
  write(out, "public/e.html", `<a href='javascript:alert("x"),process.env.T'>go</a>\n`);
  write(out, "public/ok.html", "<p>Our review process takes a day.</p><script>const n = 1;</script>\n");
  const f = floorCheck(out);
  for (const name of ["public/a.html", "public/b.htm", "public/c.html", "public/d.html", "public/e.html"]) assert.ok(f.some((l) => l.startsWith(`FAIL F1-4 ${name}:`)), `${name} in\n${f.join("\n")}`);
  assert.ok(!f.some((l) => l.includes("public/ok.html")), f.join("\n"));
});
